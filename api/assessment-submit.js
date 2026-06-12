// api/assessment-submit.js
// PUBLIEKE POST-endpoint: registreert een nieuwe assessment-inzending.
// Geen auth (deelnemers zijn niet ingelogd).
//
// In deze Blok 2 PR1: capture-only. We schrijven status='submitted' en
// laten routing_result + score NULL. Latere PR's voegen scoring-engine +
// outbound side-effects toe.
//
// Body (JSON):
//   {
//     event_id?: uuid,            // optioneel (?event=<uuid> kan ook)
//     answers: { [key]: value },  // ten minste de required questions
//     hp_company?: string         // honeypot - moet leeg zijn
//   }
//
// Anti-abuse:
//   - Honeypot: 'hp_company' moet ontbreken/leeg zijn (bots vullen 'm).
//   - IP-rate-limit: zelfde IP-hash mag max 1 inzending per 30s.
//
// Response 200: { ok: true, id: uuid, routing_result: null, status: 'submitted' }
// Response 400: validation errors {error, errors:[{key,code,message}]}
// Response 405: POST only
// Response 422: honeypot tripped
// Response 429: rate-limit hit
// Response 500: database-fout

import { supabaseAdmin } from './supabase.js';
import {
  loadActiveQuestions,
  validateAnswers,
  extractClientIp,
  hashIp,
  isRateLimited,
  UUID_RE,
  EMAIL_RE,
} from './_lib/assessment-validation.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // 1) Body parsen
  let body = null;
  try {
    body = (req.body && typeof req.body === 'object') ? req.body : null;
  } catch {
    return res.status(400).json({ error: 'Body moet JSON zijn.' });
  }
  if (!body) return res.status(400).json({ error: 'Body ontbreekt.' });

  // 2) Honeypot
  const hp = body.hp_company;
  if (hp != null && String(hp).trim() !== '') {
    // Bot-signature: nooit details lekken. Voor mensen die per ongeluk
    // browser-autofill triggeren is de melding bewust generiek.
    return res.status(422).json({ error: 'Inzending kon niet worden verwerkt.' });
  }

  // 3) Optionele event_id (?event=<uuid> OF body.event_id)
  const eventIdRaw = (req.query?.event ? String(req.query.event) : null)
    || (typeof body.event_id === 'string' ? body.event_id : null);
  let eventId = null;
  if (eventIdRaw) {
    if (!UUID_RE.test(eventIdRaw)) {
      return res.status(400).json({ error: 'event_id (uuid) ongeldig.' });
    }
    eventId = eventIdRaw;
  }

  // 4) Rate-limit per IP-hash
  const ip       = extractClientIp(req);
  const ipHash   = hashIp(ip);
  const { limited, latest_at } = await isRateLimited({ ipHash, withinSeconds: 30 });
  if (limited) {
    return res.status(429).json({
      error: 'Te veel inzendingen vanaf dit IP. Probeer het over 30 seconden opnieuw.',
      latest_at,
    });
  }

  // 5) Vragen + answer-validation
  let questions;
  try {
    questions = await loadActiveQuestions();
  } catch (e) {
    console.error('[assessment-submit] loadActiveQuestions:', e.message);
    return res.status(500).json({ error: 'Vragenlijst niet beschikbaar.' });
  }
  if (!questions.length) {
    return res.status(500).json({ error: 'Geen actieve vragen geconfigureerd.' });
  }

  const { ok, errors, normalized } = validateAnswers({
    questions,
    answers: body.answers,
  });
  if (!ok) {
    return res.status(400).json({ error: 'Validatie mislukt.', errors });
  }

  // 6) Identiteit uit normalized halen (deze 3 zijn required + seed-gegarandeerd).
  const email     = normalized.email     || null;
  const firstName = normalized.voornaam  || null;
  const lastName  = normalized.achternaam|| null;
  if (!email || !EMAIL_RE.test(email)) {
    // Defense-in-depth: validateAnswers had dit al moeten vangen.
    return res.status(400).json({ error: 'E-mailadres ontbreekt.' });
  }

  // 7) Insert
  try {
    const { data: row, error } = await supabaseAdmin
      .from('assessment_responses')
      .insert({
        event_id          : eventId,
        email             : email,
        first_name        : firstName,
        last_name         : lastName,
        answers           : normalized,
        routing_result    : null,
        score             : null,
        status            : 'submitted',
        submitter_ip_hash : ipHash,
      })
      .select('id, status, submitted_at')
      .maybeSingle();
    if (error) throw new Error('insert: ' + error.message);
    if (!row)  throw new Error('insert returnde geen rij.');

    return res.status(200).json({
      ok            : true,
      id            : row.id,
      status        : row.status,
      routing_result: null,
      submitted_at  : row.submitted_at,
    });
  } catch (e) {
    console.error('[assessment-submit] insert', e.message);
    return res.status(500).json({ error: 'Inzending kon niet worden opgeslagen.' });
  }
}
