// api/assessment-submit.js
// PUBLIEKE POST-endpoint: registreert een nieuwe assessment-inzending.
// Geen auth (deelnemers zijn niet ingelogd).
//
// Blok 2 PR 2: scoring + routing-engine is geactiveerd. Na insert wordt
// score() aangeroepen en de rij geupdate met routing_result + score jsonb.
// Side-effects (GHL push, event-koppeling) komen pas in PR 3.
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
// Response 200: {
//   ok: true, id, status: 'submitted', submitted_at,
//   routing_result: 'gevorderd'|'basis'|'incomplete',
//   copy_tier: 'high'|'mid'|'low'|'incomplete',
//   copy_text: string,
//   skill_score, engagement_ok
// }
// Response 400: validation errors {error, errors:[{key,code,message}]}
// Response 405: POST only
// Response 422: honeypot tripped
// Response 429: rate-limit hit
// Response 500: database-fout

import { supabaseAdmin } from './supabase.js';
import { createNotification } from './_lib/notify.js';
import {
  loadActiveQuestions,
  validateAnswers,
  extractClientIp,
  hashIp,
  isRateLimited,
  UUID_RE,
  EMAIL_RE,
} from './_lib/assessment-validation.js';
import { score } from './_lib/assessment-scoring.js';
import { getActiveQuestionnaire } from './_lib/assessment-questionnaires.js';

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
  // FEATURE C: zoek eerst de actieve vragenlijst zodat we per-vragenlijst
  // drempels kunnen toepassen en questionnaire_id op de response kunnen
  // schrijven. Bij geen actieve rij (legacy) fall-back op alle actieve
  // vragen (loadActiveQuestions(null)).
  const activeQuestionnaire = await getActiveQuestionnaire();
  let questions;
  try {
    questions = await loadActiveQuestions(activeQuestionnaire?.id || null);
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

  // 7) Score + insert in 1 atomic write
  // FEATURE C: drempels van de actieve vragenlijst meegeven aan score().
  let scored;
  try {
    scored = score(normalized, questions, activeQuestionnaire);
  } catch (e) {
    // Pure functie - faalt alleen bij programmer-error, niet bij data.
    console.error('[assessment-submit] score() threw:', e.message);
    return res.status(500).json({ error: 'Scoring mislukte.' });
  }

  // score-jsonb voor DB: alles behalve routing_result (eigen kolom) +
  // copy_text (afgeleid van copy_tier, niet persisten).
  const scoreJson = {
    skill_score    : scored.skill_score,
    skill_breakdown: scored.skill_breakdown,
    motivatie      : scored.motivatie,
    engagement_ok  : scored.engagement_ok,
    copy_tier      : scored.copy_tier,
    reason         : scored.reason,
    thresholds     : scored.thresholds,
    missing_keys   : scored.missing_keys,
    scored_at      : new Date().toISOString(),
  };

  try {
    const { data: row, error } = await supabaseAdmin
      .from('assessment_responses')
      .insert({
        event_id          : eventId,
        email             : email,
        first_name        : firstName,
        last_name         : lastName,
        answers           : normalized,
        routing_result    : scored.routing_result,
        score             : scoreJson,
        status            : 'submitted',
        submitter_ip_hash : ipHash,
        // FEATURE C: vastleggen welke vragenlijst gold bij submit. NULL als
        // geen actieve rij (legacy / pre-migration); FK SET NULL als de
        // vragenlijst later verwijderd wordt → response blijft leesbaar.
        questionnaire_id  : activeQuestionnaire?.id || null,
      })
      .select('id, status, routing_result, submitted_at')
      .maybeSingle();
    if (error) throw new Error('insert: ' + error.message);
    if (!row)  throw new Error('insert returnde geen rij.');

    // Late-koppeling aan bestaande aanwezigen.
    // Use-case: iemand is via Webflow al als aanwezige geregistreerd
    // (assessment_response_id IS NULL, "Vragenlijst Ontbreekt") en vult
    // de vragenlijst later in, maar stopt vóór de datumkeuze. De normale
    // koppelpaden (assessment-register bij date-pick, event-choice-submit
    // via keuze-link) raken die persoon dan niet. Hier koppelen we ALLE
    // matchende event_attendees aan deze response op basis van e-mail —
    // dezelfde identiteit-aanname als in de andere recovery-paden.
    //
    // Best-effort + fail-soft: een fout hier mag de submit NOOIT laten
    // falen — de response is al opgeslagen.
    //
    // Side-effect (bewust): aanwezigen flippen van "Ontbreekt" (telt
    // niet mee) naar "Actief" (telt mee). Dit kan een event over de
    // getoonde capaciteit duwen — correct, want die persoon was al
    // reëel aangemeld.
    //
    // Routing 'incomplete' (bv. niet-NL spreker): naast het koppelen zetten
    // we de status op 'geannuleerd' zodat ze NIET meer in de capaciteit
    // tellen (CONFIRMED_STATUSES = ['aangemeld','aanwezig']). Status alleen
    // overschrijven bij 'aangemeld' — operator-edits naar aanwezig/sale/etc
    // blijven gerespecteerd.
    const isIncomplete = scored.routing_result === 'incomplete';
    try {
      const { data: existing, error: lookupErr } = await supabaseAdmin
        .from('event_attendees')
        .select('id, first_name, last_name, status')
        .ilike('email', email)
        .is('assessment_response_id', null);
      if (lookupErr) {
        console.error('[assessment-submit] late-link lookup:', lookupErr.message);
      } else if (Array.isArray(existing) && existing.length > 0) {
        // Per rij updaten: assessment_response_id altijd, first/last_name
        // alleen als ze nu leeg/null zijn (bestaande namen NIET overschrijven
        // — operator-edits respecteren).
        for (const att of existing) {
          // assessment_linked_at is critical voor on_assessment_completed-triggers
          // (events-automation-engine r229 filtert hierop bij newOnly).
          const patch = {
            assessment_response_id: row.id,
            assessment_linked_at: new Date().toISOString(),
          };
          const fnEmpty = !(att.first_name && String(att.first_name).trim());
          const lnEmpty = !(att.last_name  && String(att.last_name).trim());
          if (fnEmpty && firstName) patch.first_name = firstName;
          if (lnEmpty && lastName)  patch.last_name  = lastName;
          // Annuleer alleen rijen die nog op 'aangemeld' staan — operator-
          // edits (aanwezig / sale / no_show) blijven intact.
          if (isIncomplete && att.status === 'aangemeld') {
            patch.status = 'geannuleerd';
          }
          const { error: updErr } = await supabaseAdmin
            .from('event_attendees')
            .update(patch)
            .eq('id', att.id);
          if (updErr) {
            console.error('[assessment-submit] late-link update:', att.id, updErr.message);
          }
        }
      }
    } catch (e) {
      console.error('[assessment-submit] late-link exception:', e?.message || e);
    }

    // Fail-soft dual-write: notify de mentor van de deelnemer (via
    // onboardings.mentor_user_id op de customer, indien er een klant-
    // koppeling is via email). Anders fallback naar toRole:['manager'].
    // Titel bevat deelnemer-naam; body event-context.
    try {
      const participantName = [firstName, lastName].filter(Boolean).join(' ') || email;
      let mentorUserId = null;
      if (eventId && email) {
        try {
          const { data: cust } = await supabaseAdmin
            .from('customers')
            .select('id')
            .ilike('email', email)
            .maybeSingle();
          if (cust && cust.id) {
            const { data: ob } = await supabaseAdmin
              .from('onboardings')
              .select('mentor_user_id')
              .eq('customer_id', cust.id)
              .not('mentor_user_id', 'is', null)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            mentorUserId = ob?.mentor_user_id || null;
          }
        } catch (_) { /* fail-soft */ }
      }
      let eventTitleA = null;
      if (eventId) {
        try {
          const { data: ev } = await supabaseAdmin
            .from('events')
            .select('title')
            .eq('id', eventId)
            .maybeSingle();
          eventTitleA = ev?.title || null;
        } catch (_) { /* fail-soft */ }
      }
      const bodyText = eventTitleA ? (eventTitleA + ' · ' + email) : email;
      const payload = {
        type:       'event.assessment_submitted',
        title:      'Vragenlijst ingevuld · ' + participantName,
        body:       bodyText,
        linkUrl:    eventId ? ('/modules/events-detail.html?id=' + eventId) : '/modules/events-detail.html',
        entityType: 'event',
        entityId:   eventId || null,
      };
      if (mentorUserId) {
        createNotification({ toUserId: mentorUserId, ...payload }).catch(() => {});
      } else {
        createNotification({ toRole: ['manager'], ...payload }).catch(() => {});
      }
    } catch (_) { /* fail-soft */ }

    return res.status(200).json({
      ok            : true,
      id            : row.id,
      status        : row.status,
      submitted_at  : row.submitted_at,
      routing_result: row.routing_result,
      copy_tier     : scored.copy_tier,
      copy_text     : scored.copy_text,
      skill_score   : scored.skill_score,
      engagement_ok : scored.engagement_ok,
    });
  } catch (e) {
    console.error('[assessment-submit] insert', e.message);
    return res.status(500).json({ error: 'Inzending kon niet worden opgeslagen.' });
  }
}
