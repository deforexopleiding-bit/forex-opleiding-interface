// api/event-vervolg-finalize.js
//
// STAP 2 — de aanmelding DEFINITIEF maken door de INFO-ONLY vervolgvragen op te
// slaan. Server-to-server via x-internal-token == OPSTARTSESSIE_SECRET.
//
// POST { t: <choice_token>, answers: { key: value }, target_event_id?: uuid }
//
// Flow:
//   1. Attendee op token; al definitief → { status:'al_definitief' } (idempotent).
//   2. Antwoorden valideren tegen de 'event-vervolg'-vragen (GEEN scoring).
//   3. Doel-event = target_event_id (indien meegegeven) anders het huidige.
//   4. Capaciteit herchecken (getConfirmedCount vs capacity). VOL →
//      { status:'vol', alternatives:[…] } (niet finaliseren).
//   5. Bij ander doel-event: verhuizen via switched_from/to-mechaniek (nieuwe
//      rij op doel, bron → 'switched_to_other_event'); daarna op de nieuwe rij.
//   6. assessment_responses-rij (info-only) schrijven + koppelen aan de rij
//      (assessment_response_id + assessment_linked_at) = DEFINITIEF (telt mee).
//
// OUDE-FLOW-VEILIG: schrijft NOOIT via assessment-submit, raakt de actieve
// questionnaire niet, en muteert alleen deze eigen gate-rij (created_via='website').
// De capaciteitsregel (getConfirmedCount) blijft ongewijzigd.

import { supabaseAdmin } from './supabase.js';
import { validateAnswers, loadActiveQuestions } from './_lib/assessment-validation.js';
import { getConfirmedCount, getOpenEventsWithSpace } from './_lib/event-registration.js';
import { onConfirmedAttendeeMutation } from './_lib/event-attendee-mutations.js';
import { getVervolgQuestionnaire, getAttendeeByToken, getEvent, isUuid } from './_lib/event-vervolg.js';
import { sendEventAttendeeBevestiging } from './_lib/events-bevestiging-send.js';
import { reedsVerstuurd, markeerVerstuurd, SOORTEN } from './_lib/event-website-berichten.js';

function alt(e) {
  return { id: e.id, titel: e.title, starts_at: e.starts_at, ends_at: e.ends_at, locatie: e.location, vrij: e.has_space ? Math.max(0, (e.capacity || 0) - (e.confirmed_count || 0)) : 0 };
}
async function buildAlternatives(currentEventId, niveau) {
  let list;
  try { list = await getOpenEventsWithSpace({ niveau: niveau || null }); } catch { list = []; }
  return (list || []).filter((e) => e.id !== currentEventId && e.has_space).map(alt);
}

// Verhuizing (pending-aanmelder): nieuwe rij op doel-event + bron markeren als
// switched. Spiegelt api/events-attendee-move.js maar server-side (geen auth-user).
async function verhuisAttendee(source, targetEventId) {
  const nowIso = new Date().toISOString();
  const { data: newRow, error: insErr } = await supabaseAdmin
    .from('event_attendees')
    .insert({
      event_id: targetEventId,
      first_name: source.first_name, last_name: source.last_name,
      email: source.email, phone: source.phone,
      status: 'aangemeld', source: source.source || 'website', created_via: 'website',
      registered_at: nowIso, is_test: false, automation_enabled: false,
      customer_id: source.customer_id || null,
      switched_from_event_id: source.event_id,
    })
    .select('id, event_id, first_name, last_name, email, phone, customer_id')
    .maybeSingle();
  if (insErr) throw new Error('verhuis-insert: ' + insErr.message);
  const { error: updErr } = await supabaseAdmin
    .from('event_attendees')
    .update({ status: 'switched_to_other_event', switched_to_event_id: targetEventId, switched_at: nowIso })
    .eq('id', source.id);
  if (updErr) throw new Error('verhuis-bron-update: ' + updErr.message);
  return newRow;
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
  const answers = (body.answers && typeof body.answers === 'object') ? body.answers : null;
  const targetEventId = body.target_event_id ? String(body.target_event_id) : null;
  if (!isUuid(token)) return res.status(400).json({ error: 'geldige token vereist' });
  if (!answers) return res.status(400).json({ error: 'answers vereist' });
  if (targetEventId && !isUuid(targetEventId)) return res.status(400).json({ error: 'target_event_id ongeldig' });

  try {
    let attendee = await getAttendeeByToken(token);
    if (!attendee) return res.status(404).json({ error: 'Aanmelding niet gevonden' });
    if (attendee.assessment_response_id) {
      return res.status(200).json({ status: 'al_definitief' });
    }

    // Antwoorden valideren tegen de info-only vragen (geen scoring/annulering).
    const q = await getVervolgQuestionnaire();
    if (!q?.id) return res.status(503).json({ error: 'Vervolgvragenlijst niet geconfigureerd' });
    const questions = await loadActiveQuestions(q.id);
    if (!questions.length) return res.status(503).json({ error: 'Geen vervolgvragen geconfigureerd' });
    const { ok, errors, normalized } = validateAnswers({ questions, answers });
    if (!ok) return res.status(400).json({ error: 'Validatie mislukt', errors });

    // Doel-event bepalen + capaciteit herchecken.
    const doelId = targetEventId || attendee.event_id;
    const doel = await getEvent(doelId);
    if (!doel) return res.status(404).json({ error: 'Doel-event niet gevonden' });

    const cap = Number.isInteger(Number(doel.capacity)) ? Number(doel.capacity) : null;
    if (cap && cap > 0) {
      const count = await getConfirmedCount(doel.id);
      if (count >= cap) {
        return res.status(200).json({ status: 'vol', alternatives: await buildAlternatives(doel.id, doel.niveau) });
      }
    }

    // Verhuizen indien een ander event gekozen is.
    if (targetEventId && targetEventId !== attendee.event_id) {
      attendee = await verhuisAttendee(attendee, targetEventId);
    }

    // Info-only response opslaan.
    const email = String(attendee.email || '').trim().toLowerCase();
    const { data: resp, error: respErr } = await supabaseAdmin
      .from('assessment_responses')
      .insert({
        event_id: attendee.event_id,
        email,
        first_name: attendee.first_name || null,
        last_name: attendee.last_name || null,
        answers: normalized,
        routing_result: null,
        score: null,
        status: 'submitted',
        questionnaire_id: q.id,
      })
      .select('id')
      .maybeSingle();
    if (respErr) throw new Error('response-insert: ' + respErr.message);

    // Koppelen = DEFINITIEF (telt nu mee voor capaciteit).
    const { error: linkErr } = await supabaseAdmin
      .from('event_attendees')
      .update({ assessment_response_id: resp.id, assessment_linked_at: new Date().toISOString() })
      .eq('id', attendee.id);
    if (linkErr) throw new Error('koppel-update: ' + linkErr.message);

    // Fail-soft: auto-close-triplet als het event hierdoor vol raakt.
    try { await onConfirmedAttendeeMutation([attendee.event_id], { reason: 'event-vervolg-finalize' }); }
    catch (e) { console.error('[event-vervolg-finalize] auto-close (soft):', e?.message || e); }

    // FUNNEL-EIGEN bevestiging (mail + WhatsApp) — fail-soft + idempotent via de
    // logtabel (soort='bevestiging'). Blokkeert de response nooit. Alleen dit
    // website-pad; raakt event_automations/automation_enabled niet.
    try {
      if (!(await reedsVerstuurd(attendee.id, SOORTEN.BEVESTIGING))) {
        const r = await sendEventAttendeeBevestiging({ attendeeId: attendee.id });
        if (r?.ok) await markeerVerstuurd(attendee.id, attendee.event_id, SOORTEN.BEVESTIGING, 'mail+whatsapp');
      }
    } catch (e) { console.error('[event-vervolg-finalize] bevestiging (soft):', e?.message || e); }

    return res.status(200).json({
      status: 'definitief',
      event: { id: doel.id, titel: doel.title, starts_at: doel.starts_at, ends_at: doel.ends_at, locatie: doel.location },
    });
  } catch (e) {
    console.error('[event-vervolg-finalize]', e?.message || e);
    return res.status(500).json({ error: 'Definitief maken mislukt' });
  }
}
