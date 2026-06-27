// api/events-signup-inbox-list.js
// GET -> lijst van inbox-rijen voor admin-review.
//
// Sessie-JWT + RBAC events.attendee.create (zelfde permission als
// /api/events-attendee-add, omdat de resolve-actie effectief een
// attendee aanmaakt vanuit een inbox-rij).
//
// Query:
//   ?status=matched|ambiguous|no_match|invalid_payload   (optioneel; default all)
//   ?limit=<1-200>                                       (default 50)
//   ?offset=<0+>                                         (default 0)
//
// Response 200:
//   { rows: [{ id, source, received_at, match_status, ghl_contact_id,
//              ghl_form_submission_id, event_date_label, first_name,
//              last_name, email, phone, matched_event_id, matched_attendee_id,
//              match_candidate_ids, resolved_at, notes,
//              matched_event: { id, title, starts_at, niveau, capacity, signups_closed } | null }],
//     counts: { matched, ambiguous, no_match, invalid_payload, total },
//     limit, offset }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ALLOWED_STATUSES = ['matched', 'ambiguous', 'no_match', 'invalid_payload'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.create'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.create)' });
  }

  const statusParam = req.query?.status ? String(req.query.status).toLowerCase() : null;
  if (statusParam && !ALLOWED_STATUSES.includes(statusParam)) {
    return res.status(400).json({ error: `status moet ${ALLOWED_STATUSES.join('|')} zijn` });
  }

  const limit  = Math.min(200, Math.max(1, parseInt(req.query?.limit  || '50', 10) || 50));
  const offset = Math.max(0, parseInt(req.query?.offset || '0', 10) || 0);

  try {
    // Counts per status (1 round-trip).
    const { data: countRows, error: cntErr } = await supabaseAdmin
      .from('event_signup_inbox')
      .select('match_status');
    if (cntErr) throw new Error('count fetch: ' + cntErr.message);
    const counts = { matched: 0, ambiguous: 0, no_match: 0, invalid_payload: 0, total: 0 };
    for (const r of (countRows || [])) {
      counts.total++;
      if (counts[r.match_status] != null) counts[r.match_status]++;
    }

    // Hoofdquery met embed van het matched event (zonder embed loopt admin
    // anders een N+1).
    let q = supabaseAdmin
      .from('event_signup_inbox')
      .select(`
        id, source, received_at, match_status,
        ghl_contact_id, ghl_form_submission_id, event_date_label,
        first_name, last_name, email, phone,
        matched_event_id, matched_attendee_id, match_candidate_ids,
        resolved_at, resolved_by_user_id, notes,
        matched_event:events!event_signup_inbox_matched_event_id_fkey (
          id, title, starts_at, ends_at, niveau, capacity, signups_closed, status
        )
      `)
      .order('received_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (statusParam) q = q.eq('match_status', statusParam);

    const { data: rows, error: rowErr } = await q;
    if (rowErr) throw new Error('rows fetch: ' + rowErr.message);

    // ── Vragenlijst-status per matched-attendee ────────────────────────
    // Voor elke rij met matched_attendee_id zoeken we de bijbehorende
    // assessment_response_id en (indien aanwezig) de invuldatum. Dat zijn
    // twee batched queries (geen N+1). Fail-soft: bij DB-fout krijgt elke
    // rij filled=false, datum=null — geen 500.
    const attendeeIds = Array.from(new Set(
      (rows || []).map((r) => r.matched_attendee_id).filter(Boolean)
    ));
    const responseIdByAttendee = new Map();
    const filledAtByResponse   = new Map();
    if (attendeeIds.length > 0) {
      try {
        const { data: attRows, error: attErr } = await supabaseAdmin
          .from('event_attendees')
          .select('id, assessment_response_id')
          .in('id', attendeeIds);
        if (attErr) {
          console.error('[events-signup-inbox-list attendees]', attErr.message);
        } else {
          for (const a of (attRows || [])) {
            if (a && a.id) responseIdByAttendee.set(a.id, a.assessment_response_id || null);
          }
        }
        const responseIds = Array.from(new Set(
          Array.from(responseIdByAttendee.values()).filter(Boolean)
        ));
        if (responseIds.length > 0) {
          const { data: respRows, error: respErr } = await supabaseAdmin
            .from('assessment_responses')
            .select('id, submitted_at, created_at')
            .in('id', responseIds);
          if (respErr) {
            console.error('[events-signup-inbox-list responses]', respErr.message);
          } else {
            for (const r of (respRows || [])) {
              if (r && r.id) filledAtByResponse.set(r.id, r.submitted_at || r.created_at || null);
            }
          }
        }
      } catch (e) {
        console.error('[events-signup-inbox-list questionnaire-fetch]', e?.message || e);
      }
    }

    const enriched = (rows || []).map((r) => {
      const respId = r.matched_attendee_id ? responseIdByAttendee.get(r.matched_attendee_id) : null;
      return {
        ...r,
        questionnaire_filled    : !!respId,
        questionnaire_filled_at : respId ? (filledAtByResponse.get(respId) || null) : null,
      };
    });

    return res.status(200).json({
      rows: enriched,
      counts,
      limit,
      offset,
      status_filter: statusParam || null,
    });
  } catch (e) {
    console.error('[events-signup-inbox-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
