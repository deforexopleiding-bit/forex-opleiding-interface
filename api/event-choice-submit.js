// api/event-choice-submit.js
//
// PUBLIEK POST-endpoint. Token-based, geen createUserClient.
//
// Doel (Fase 2b): een deelnemer met een persoonlijke choice-link verhuist
// z'n inschrijving naar een ander event-met-plek. De assessment-koppeling
// (assessment_response_id + naam/email) gaat mee. De oude rij wordt op
// status='switched_to_other_event' gezet (audit-trail); een nieuwe rij
// wordt aangemaakt op het target-event met switched_from_event_id zodat
// we de switch bidirectioneel kunnen volgen.
//
// Body (JSON):
//   { t: <choice_token uuid>, target_event_id: <uuid> }
//
// Atomiciteit:
//   Supabase REST heeft geen multi-statement transactions; we doen
//   INSERT-then-UPDATE met best-effort rollback. INSERT eerst zodat een
//   23505 op de target-UNIQUE direct 409 DUPLICATE oplevert ZONDER de
//   oude rij aan te raken. Slaagt INSERT en faalt UPDATE → DELETE de
//   net-aangemaakte rij + 500.
//
// Foutcodes (spiegelen assessment.html):
//   400  TOKEN_REQUIRED / TARGET_REQUIRED / VALIDATION_*
//   404  TOKEN_INVALID    (token onbekend) | EVENT_NOT_FOUND
//   409  EVENT_NOT_OPEN | EVENT_CLOSED | NIVEAU_MISMATCH | DUPLICATE | EVENT_FULL
//   429  rate-limit
//   500  database-fout
//
// Response 200 (target == huidig event):
//   { ok: true, code: 'NO_OP', current_event_id }
//
// Response 200 (succes):
//   { ok: true, new_attendee_id, old_attendee_id, target_event_id,
//     old_event_id, confirmed_count_target, capacity_target,
//     gastenlijst_label_target, auto_closed_target,
//     gastenlijst_label_old }

import { supabaseAdmin } from './supabase.js';
import { extractClientIp, hashIp } from './_lib/assessment-validation.js';
import {
  isNiveauMatch,
  getConfirmedCount,
  syncGastenlijstWebflow,
  autoCloseIfFull,
} from './_lib/event-registration.js';

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
    console.error('[event-choice-submit] rate-limit query:', error.message);
    return false; // soft-fail open
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
    console.error('[event-choice-submit] log insert:', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // 1) Body parse + validatie
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt.' });

  const token = typeof body.t === 'string' ? body.t.trim() : null;
  const targetEventId = typeof body.target_event_id === 'string'
    ? body.target_event_id.trim() : null;
  if (!token || !UUID_RE.test(token)) {
    return res.status(400).json({ error: 'Token vereist.', code: 'TOKEN_REQUIRED' });
  }
  if (!targetEventId || !UUID_RE.test(targetEventId)) {
    return res.status(400).json({ error: 'target_event_id vereist.', code: 'TARGET_REQUIRED' });
  }

  // 2) Rate-limit
  const ip = extractClientIp(req);
  const ipHash = hashIp(ip);
  if (await isIpRateLimited(ipHash)) {
    return res.status(429).json({ error: 'Te veel verzoeken. Probeer het later opnieuw.' });
  }

  // Lookup loggen ongeacht uitkomst zodat brute-forcers tegen het limit
  // aanlopen. Voor 200 / 4xx / 5xx gebeurt dit altijd.
  await logLookup(ipHash);

  try {
    // 3) Token → attendee
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, first_name, last_name, email, assessment_response_id')
      .eq('choice_token', token)
      .maybeSingle();
    if (attErr) {
      console.error('[event-choice-submit] attendee fetch:', attErr.message);
      return res.status(500).json({ error: 'Kon link niet ophalen.' });
    }
    if (!attendee) {
      return res.status(404).json({ error: 'Link niet geldig.', code: 'TOKEN_INVALID' });
    }

    // 4) Target-event ophalen + open-gates
    const { data: targetEvent, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, status, signups_closed, niveau, capacity, webflow_item_id')
      .eq('id', targetEventId)
      .maybeSingle();
    if (evErr) {
      console.error('[event-choice-submit] event fetch:', evErr.message);
      return res.status(500).json({ error: 'Kon event niet ophalen.' });
    }
    if (!targetEvent) {
      return res.status(404).json({ error: 'Event niet gevonden.', code: 'EVENT_NOT_FOUND' });
    }
    if (targetEvent.status !== 'published') {
      return res.status(409).json({
        error: 'Event is niet open voor inschrijving.',
        code : 'EVENT_NOT_OPEN',
      });
    }
    if (targetEvent.signups_closed === true) {
      return res.status(409).json({
        error: 'Inschrijvingen zijn gesloten voor dit event.',
        code : 'EVENT_CLOSED',
      });
    }

    // 5) Niveau-check indien assessment aanwezig
    if (attendee.assessment_response_id) {
      try {
        const { data: ar } = await supabaseAdmin
          .from('assessment_responses')
          .select('routing_result')
          .eq('id', attendee.assessment_response_id)
          .maybeSingle();
        const routing = ar?.routing_result || null;
        if (routing === 'basis' || routing === 'gevorderd') {
          if (!isNiveauMatch(routing, targetEvent.niveau)) {
            return res.status(409).json({
              error: `Niveau van event komt niet overeen met jouw resultaat (${routing} vs ${targetEvent.niveau}).`,
              code : 'NIVEAU_MISMATCH',
            });
          }
        }
        // 'incomplete' / null: niveau-check overslaan (signup-first pad
        // krijgt z'n niveau pas na Fase 2c).
      } catch (e) {
        console.error('[event-choice-submit] assessment fetch:', e?.message || e);
        // Soft-fail: laat niveau-check vallen i.p.v. crash; UI's
        // foutboodschap zou hier onhelpzaam zijn.
      }
    }

    // 6) Same-event no-op
    if (attendee.event_id === targetEvent.id) {
      return res.status(200).json({
        ok               : true,
        code             : 'NO_OP',
        current_event_id : attendee.event_id,
      });
    }

    // 7) Race-safe has_space hercheck
    const currentTargetCount = await getConfirmedCount(targetEvent.id);
    const targetCap = Number.isInteger(Number(targetEvent.capacity))
      ? Number(targetEvent.capacity) : null;
    if (targetCap != null && currentTargetCount >= targetCap) {
      return res.status(409).json({
        error: 'Dit event is net vol.',
        code : 'EVENT_FULL',
      });
    }

    // 8) INSERT nieuwe rij op target. INSERT-eerst zodat een 23505 op de
    // target-UNIQUE direct 409 DUPLICATE oplevert ZONDER de oude rij aan
    // te raken. choice_token niet expliciet gezet → default genereert
    // nieuw uuid (per-rij volatile gen_random_uuid()).
    let newAttendeeId;
    {
      const { data: newRow, error: insErr } = await supabaseAdmin
        .from('event_attendees')
        .insert({
          event_id              : targetEvent.id,
          first_name            : attendee.first_name,
          last_name             : attendee.last_name,
          email                 : attendee.email,
          status                : 'aangemeld',
          created_via           : 'choice',
          assessment_response_id: attendee.assessment_response_id || null,
          switched_from_event_id: attendee.event_id,
          registered_at         : new Date().toISOString(),
        })
        .select('id')
        .maybeSingle();
      if (insErr) {
        if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
          return res.status(409).json({
            error: 'Je staat al ingeschreven voor dit event.',
            code : 'DUPLICATE',
          });
        }
        console.error('[event-choice-submit] insert:', insErr.message);
        return res.status(500).json({ error: 'Kon nieuwe inschrijving niet aanmaken.' });
      }
      if (!newRow) {
        return res.status(500).json({ error: 'Geen nieuwe inschrijving terug.' });
      }
      newAttendeeId = newRow.id;
    }

    // 9) UPDATE oude rij naar switched_to_other_event. Faalt dit dan
    // DELETE we de net-aangemaakte rij (best-effort rollback) en geven
    // 500 terug. Voorkomt dat een attendee per ongeluk op 2 events tegelijk
    // staat na een halfgelukte switch.
    const nowIso = new Date().toISOString();
    {
      const { error: updErr } = await supabaseAdmin
        .from('event_attendees')
        .update({
          status      : 'switched_to_other_event',
          switched_at : nowIso,
        })
        .eq('id', attendee.id);
      if (updErr) {
        console.error('[event-choice-submit] update old:', updErr.message);
        // Best-effort rollback
        try {
          await supabaseAdmin.from('event_attendees').delete().eq('id', newAttendeeId);
        } catch (rbErr) {
          console.error('[event-choice-submit] rollback delete:', rbErr?.message || rbErr);
        }
        return res.status(500).json({ error: 'Kon oude inschrijving niet bijwerken.' });
      }
    }

    // 10) Side-effects.
    //   Target: recount + gastenlijst + auto-close-if-full.
    //   Oud:    recount + gastenlijst (geen auto-reopen — capaciteit ging
    //           omlaag; signups_closed handmatig laten staan).
    const oldEventId = attendee.event_id;

    let targetCount        = 0;
    let targetGastenlijst  = { ok: true, skipped: true, label: null };
    let targetAutoClose    = { ok: true, skipped: true };
    try {
      targetCount = await getConfirmedCount(targetEvent.id);
      targetGastenlijst = await syncGastenlijstWebflow(targetEvent, targetCount);
      targetAutoClose   = await autoCloseIfFull(targetEvent, targetCount);
    } catch (e) {
      console.error('[event-choice-submit] target cascade:', e?.message || e);
    }

    let oldGastenlijst = { ok: true, skipped: true, label: null };
    try {
      const oldCount = await getConfirmedCount(oldEventId);
      // Oud event-row ophalen voor webflow_item_id + capacity (nodig voor label).
      const { data: oldEv } = await supabaseAdmin
        .from('events')
        .select('id, capacity, webflow_item_id')
        .eq('id', oldEventId)
        .maybeSingle();
      if (oldEv) {
        oldGastenlijst = await syncGastenlijstWebflow(oldEv, oldCount);
      }
    } catch (e) {
      console.error('[event-choice-submit] old recompute:', e?.message || e);
    }

    return res.status(200).json({
      ok                        : true,
      new_attendee_id           : newAttendeeId,
      old_attendee_id           : attendee.id,
      target_event_id           : targetEvent.id,
      old_event_id              : oldEventId,
      confirmed_count_target    : targetCount,
      capacity_target           : targetCap,
      gastenlijst_label_target  : targetGastenlijst.label || null,
      gastenlijst_label_old     : oldGastenlijst.label || null,
      auto_closed_target        : !!targetAutoClose.auto_closed,
    });
  } catch (e) {
    console.error('[event-choice-submit] fatal:', e?.message || e);
    return res.status(500).json({ error: 'Kon de keuze niet verwerken.' });
  }
}
