// api/event-choice-get.js
//
// PUBLIEK read-only GET-endpoint. Input: ?t=<choice_token>.
// Geen createUserClient — de deelnemer is niet ingelogd. Token is de
// authenticatie. Onbekend/ongeldig token → 404 zonder details te lekken.
//
// Doel (Fase 2a): de persoonlijke keuze-link kan straks (Fase 2b) een UI
// renderen waarmee een deelnemer ziet (a) waar hij momenteel staat
// ingeschreven en (b) welke open events hij KAN kiezen (heeft 'ie een
// voltooide assessment → events van dat niveau met has_space; anders →
// alle open events met has_space, beide niveaus).
//
// Privacy:
//   - GEEN email, telefoon, last_name of overige PII in de response. Alleen
//     first_name (voor "Hoi, X")-tekst).
//   - Token zelf wordt NIET teruggegeven; de caller heeft 'm al in de URL.
//
// Rate-limit:
//   - IP-hash + sliding window via event_choice_lookup_log
//     (rate-limit-state-only tabel, GEEN personal data). Soft-fail bij
//     DB-glitch: rate-limit faalt open, response gaat door (verkiest
//     beschikbaarheid boven strikte limit voor een read-only endpoint).
//   - Caller logt elke lookup ná de auth-check zodat brute-force-pogingen
//     met willekeurige tokens ook tegen het limit aanlopen.
//
// Response 200:
//   {
//     attendee: {
//       first_name      : string|null,
//       current_event_id: uuid|null,        // event waar attendee NU staat
//       has_assessment  : boolean,          // assessment_response_id != null
//       niveau          : 'basis'|'gevorderd'|null,
//     },
//     events: [
//       { id, title, starts_at, ends_at, location, niveau, has_space }
//     ]
//   }
// Response 400: t (uuid) ontbreekt of ongeldig formaat
// Response 404: token onbekend  (gelijke shape om enumeratie te ontmoedigen)
// Response 405: GET only
// Response 429: rate-limit hit
// Response 500: database-fout

import { supabaseAdmin } from './supabase.js';
import { extractClientIp, hashIp } from './_lib/assessment-validation.js';
import { getOpenEventsWithSpace } from './_lib/event-registration.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT_MAX_PER_MINUTE = 30;

async function isIpRateLimited(ipHash) {
  if (!ipHash) return false;
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from('event_choice_lookup_log')
    .select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash)
    .gte('lookup_at', since);
  if (error) {
    // Soft-fail open — beschikbaarheid > strikte limit voor read-only endpoint.
    console.error('[event-choice-get] rate-limit query:', error.message);
    return false;
  }
  return typeof count === 'number' && count >= RATE_LIMIT_MAX_PER_MINUTE;
}

async function logLookup(ipHash) {
  if (!ipHash) return;
  try {
    await supabaseAdmin
      .from('event_choice_lookup_log')
      .insert({ ip_hash: ipHash });
  } catch (e) {
    console.error('[event-choice-get] log insert:', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // 1) Token parsen + valideren (zonder details bij invalid).
  const token = req.query?.t ? String(req.query.t).trim() : null;
  if (!token || !UUID_RE.test(token)) {
    return res.status(400).json({ error: 'Token vereist.' });
  }

  // 2) IP-rate-limit.
  const ip = extractClientIp(req);
  const ipHash = hashIp(ip);
  if (await isIpRateLimited(ipHash)) {
    return res.status(429).json({ error: 'Te veel verzoeken. Probeer het later opnieuw.' });
  }

  try {
    // 3) Token → attendee. GEEN email/telefoon/last_name selecteren.
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, first_name, event_id, assessment_response_id')
      .eq('choice_token', token)
      .maybeSingle();
    if (attErr) {
      console.error('[event-choice-get] attendee fetch:', attErr.message);
      // Log lookup ook bij DB-error zodat brute-forcers niet 'gratis'
      // requests doen.
      await logLookup(ipHash);
      return res.status(500).json({ error: 'Kon link niet ophalen.' });
    }
    if (!attendee) {
      // Onbekende token — log + nette 404 zonder details (geen onderscheid
      // tussen "token bestaat niet" en "token expired" → niets te leaken).
      await logLookup(ipHash);
      return res.status(404).json({ error: 'Link niet geldig.' });
    }

    // 4) Routing/niveau ophalen indien assessment-koppeling bestaat.
    let niveau = null;
    if (attendee.assessment_response_id) {
      try {
        const { data: ar, error: arErr } = await supabaseAdmin
          .from('assessment_responses')
          .select('routing_result')
          .eq('id', attendee.assessment_response_id)
          .maybeSingle();
        if (arErr) {
          console.error('[event-choice-get] assessment fetch:', arErr.message);
        } else if (ar?.routing_result === 'basis' || ar?.routing_result === 'gevorderd') {
          niveau = ar.routing_result;
        }
      } catch (e) {
        console.error('[event-choice-get] assessment exception:', e?.message || e);
      }
    }

    // 5) Open events via shared helper. Bij niveau=null → alle niveaus.
    let events = [];
    try {
      events = await getOpenEventsWithSpace({ niveau, limit: 50 });
    } catch (e) {
      console.error('[event-choice-get] events fetch:', e?.message || e);
      // Soft-fail: lever lege array. UI kan dan een "geen events
      // beschikbaar"-state tonen i.p.v. crash.
      events = [];
    }

    // 6) Lookup loggen voor rate-limit telling.
    await logLookup(ipHash);

    // 7) Privacy-safe response. Alleen first_name en attendee-status; GEEN
    // email/telefoon/last_name. Token NIET teruggeven (caller heeft 'm al).
    return res.status(200).json({
      attendee: {
        first_name      : attendee.first_name || null,
        current_event_id: attendee.event_id || null,
        has_assessment  : !!attendee.assessment_response_id,
        niveau          : niveau,
      },
      events: events.map((e) => ({
        id        : e.id,
        title     : e.title,
        starts_at : e.starts_at,
        ends_at   : e.ends_at,
        location  : e.location,
        niveau    : e.niveau,
        image_url : e.image_url,
        has_space : e.has_space,
        spots_left: e.spots_left,
      })),
    });
  } catch (e) {
    console.error('[event-choice-get] fatal:', e?.message || e);
    await logLookup(ipHash);
    return res.status(500).json({ error: 'Kon link niet ophalen.' });
  }
}
