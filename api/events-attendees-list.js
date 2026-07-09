// api/events-attendees-list.js
// GET -> paginated lijst van deelnemers per event, incl. tags-array per attendee.
//
// Permission: events.attendee.view.
//
// Query-params:
//   event_id  uuid (verplicht)
//   status    CSV optional (aangemeld|aanwezig|no_show|sale|switched_to_other_event)
//   q         text optional (ILIKE op first_name / last_name / email)
//   limit     int, default 100, clamp 1..500
//   offset    int, default 0
//
// Response:
//   {
//     items: [
//       {
//         id, event_id, first_name, last_name, email, phone, status,
//         customer_id, deal_id, subscription_id,
//         ghl_contact_id, ghl_form_submission_id, assessment_response_id,
//         switched_from_event_id, switched_at,
//         registered_at, attended_at, no_show_marked_at, sale_at,
//         follow_up_flagged, follow_up_reason,
//         created_at, updated_at,
//         tags: [ { slug, label, color, source } ]
//       }, ...
//     ],
//     total, limit, offset,
//     counts: { byStatus: { aangemeld, aanwezig, no_show, sale, switched_to_other_event } }
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUS = ['aangemeld', 'aanwezig', 'no_show', 'sale', 'switched_to_other_event', 'geannuleerd'];

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function parseCsv(raw) {
  if (raw == null) return [];
  return String(raw).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

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
  if (!(await requirePermission(req, 'events.attendee.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.view)' });
  }

  const q = req.query || {};
  const eventId = q.event_id ? String(q.event_id) : null;
  if (!eventId || !UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'event_id (uuid) vereist' });
  }

  const statusList = parseCsv(q.status).map((s) => s.toLowerCase());
  const invalidStatus = statusList.filter((s) => !VALID_STATUS.includes(s));
  if (invalidStatus.length > 0) {
    return res.status(400).json({
      error: `Ongeldige status: ${invalidStatus.join(',')}; verwacht ${VALID_STATUS.join('|')}`,
    });
  }

  const search = q.q ? String(q.q).trim() : null;
  const limit  = clampInt(q.limit, 100, 1, 500);
  const offset = Math.max(0, clampInt(q.offset, 0, 0, 1_000_000));

  try {
    // switched_to_event_id is nieuw sinds migratie 026. Fail-soft: bij
    // 42703/PGRST204 (kolom ontbreekt) retry zonder — dan blijft
    // 'switched_to_event_title' NULL en toont de UI enkel 'Verplaatst'.
    const RICH_SELECT = `
      id, event_id, first_name, last_name, email, phone, status,
      attendance_status, outcome,
      customer_id, deal_id, subscription_id,
      ghl_contact_id, ghl_form_submission_id, assessment_response_id,
      switched_from_event_id, switched_to_event_id, switched_at,
      registered_at, attended_at, no_show_marked_at, sale_at,
      follow_up_flagged, follow_up_reason, called_at, call_status, call_status_at, notes,
      source, automation_enabled,
      created_at, updated_at
    `;
    const CORE_SELECT = `
      id, event_id, first_name, last_name, email, phone, status,
      attendance_status, outcome,
      customer_id, deal_id, subscription_id,
      ghl_contact_id, ghl_form_submission_id, assessment_response_id,
      switched_from_event_id, switched_at,
      registered_at, attended_at, no_show_marked_at, sale_at,
      follow_up_flagged, follow_up_reason, called_at, call_status, call_status_at, notes,
      source, automation_enabled,
      created_at, updated_at
    `;
    const buildQuery = (selectCols) => {
      let q = supabaseAdmin
        .from('event_attendees')
        .select(selectCols, { count: 'exact' })
        .eq('event_id', eventId)
        // Automation-tester: filter test-rijen uit reguliere lijsten.
        .eq('is_test', false)
        .order('registered_at', { ascending: true })
        .range(offset, offset + limit - 1);
      if (statusList.length === 1) q = q.eq('status', statusList[0]);
      else if (statusList.length > 1) q = q.in('status', statusList);
      if (search) {
        const safe = search.replace(/[%,]/g, '');
        if (safe.length > 0) {
          const pattern = `*${safe}*`;
          q = q.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`);
        }
      }
      return q;
    };

    let rows;
    let count;
    {
      const r1 = await buildQuery(RICH_SELECT);
      if (r1.error && (r1.error.code === '42703' || r1.error.code === 'PGRST204')) {
        console.warn('[attendees-list] switched_to_event_id kolom ontbreekt — draai migratie 026 voor bestemmings-titel');
        const r2 = await buildQuery(CORE_SELECT);
        if (r2.error) throw new Error('attendees-list: ' + r2.error.message);
        rows = r2.data;
        count = r2.count;
      } else if (r1.error) {
        throw new Error('attendees-list: ' + r1.error.message);
      } else {
        rows = r1.data;
        count = r1.count;
      }
    }

    // Batch-lookup: titels van doel-events voor de rijen die verplaatst
    // zijn. Één query per unieke switched_to_event_id (max 1 round-trip).
    const targetEventIds = Array.from(new Set(
      (rows || []).map((r) => r.switched_to_event_id).filter(Boolean)
    ));
    const targetTitleById = new Map();
    if (targetEventIds.length > 0) {
      try {
        const { data: tRows, error: tErr } = await supabaseAdmin
          .from('events')
          .select('id, title')
          .in('id', targetEventIds);
        if (tErr) {
          console.error('[attendees-list target-titles]', tErr.message);
        } else {
          for (const t of tRows || []) targetTitleById.set(t.id, t.title || null);
        }
      } catch (e) {
        console.error('[attendees-list target-titles-catch]', e?.message || e);
      }
    }

    // Tags per attendee (1 query met IN-clause + groepering in JS).
    const ids = (rows || []).map((r) => r.id);
    const tagsByAttendee = new Map();
    if (ids.length > 0) {
      const { data: tagRows, error: tagErr } = await supabaseAdmin
        .from('event_attendee_tags')
        .select('attendee_id, tag_slug, source, added_at, event_tags_catalog:tag_slug ( slug, label, color )')
        .in('attendee_id', ids);
      if (tagErr) {
        console.error('[events-attendees-list tags]', tagErr.message);
      } else {
        for (const t of tagRows || []) {
          const list = tagsByAttendee.get(t.attendee_id) || [];
          const cat = t.event_tags_catalog || {};
          list.push({
            slug:   t.tag_slug,
            label:  cat.label || t.tag_slug,
            color:  cat.color || null,
            source: t.source,
            added_at: t.added_at,
          });
          tagsByAttendee.set(t.attendee_id, list);
        }
      }
    }

    // PR Z: sale-detectie via gekoppelde deals — pure flag, geen handmatige optie.
    // Een attendee is "sale" als zijn deal_id een tl_quotation_status in
    // ('accepted','signed') heeft, of een tl_quotation_accepted_at-stempel.
    const signedDealIds = new Set();
    const dealIds = Array.from(new Set((rows || []).map((r) => r.deal_id).filter(Boolean)));
    if (dealIds.length > 0) {
      try {
        const { data: deals, error: dealErr } = await supabaseAdmin
          .from('deals')
          .select('id, tl_quotation_status, tl_quotation_accepted_at')
          .in('id', dealIds);
        if (dealErr) {
          console.error('[events-attendees-list deals]', dealErr.message);
        } else {
          for (const d of deals || []) {
            const st = String(d.tl_quotation_status || '').toLowerCase();
            if (st === 'accepted' || st === 'signed' || d.tl_quotation_accepted_at) {
              signedDealIds.add(d.id);
            }
          }
        }
      } catch (e) {
        console.error('[events-attendees-list deals-fetch]', e?.message || e);
      }
    }

    // Taal per aanwezige — mirror van het tags/deals secundaire-fetch-patroon.
    // Bron: assessment_responses.answers->>'taal' (de nieuwe radio-vraag
    // 'taal' met waarden 'nl'|'en'|'anders'). Afwezigheid van de vraag
    // (oude inzendingen) → taal=null; events-detail toont dan geen badge.
    // Fail-soft: bij DB-fout → taal=null op alle rijen, geen 500.
    const responseIds = Array.from(new Set(
      (rows || []).map((r) => r.assessment_response_id).filter(Boolean)
    ));
    const taalByResponse = new Map();
    // Vragenlijst-invuldatum: canonieke kolom is submitted_at (zie
    // assessment-submit.js); fallback created_at voor zeldzame oudere
    // inzendingen waar submitted_at NULL is.
    const filledAtByResponse = new Map();
    if (responseIds.length > 0) {
      try {
        const { data: respRows, error: respErr } = await supabaseAdmin
          .from('assessment_responses')
          .select('id, answers, submitted_at, created_at')
          .in('id', responseIds);
        if (respErr) {
          console.error('[events-attendees-list responses]', respErr.message);
        } else {
          for (const rr of respRows || []) {
            const a = rr && rr.answers;
            const t = (a && typeof a === 'object' && typeof a.taal === 'string')
              ? a.taal.trim().toLowerCase()
              : null;
            taalByResponse.set(rr.id, t || null);
            filledAtByResponse.set(rr.id, rr.submitted_at || rr.created_at || null);
          }
        }
      } catch (e) {
        console.error('[events-attendees-list responses-fetch]', e?.message || e);
      }
    }

    const items = (rows || []).map((r) => ({
      ...r,
      tags: tagsByAttendee.get(r.id) || [],
      has_signed_deal: !!(r.deal_id && signedDealIds.has(r.deal_id)),
      taal: r.assessment_response_id ? (taalByResponse.get(r.assessment_response_id) || null) : null,
      questionnaire_filled_at: r.assessment_response_id
        ? (filledAtByResponse.get(r.assessment_response_id) || null)
        : null,
      // Bestemmings-titel voor verplaatst-attendees (migratie 026). NULL
      // voor legacy-rijen zonder switched_to_event_id.
      switched_to_event_title: r.switched_to_event_id
        ? (targetTitleById.get(r.switched_to_event_id) || null)
        : null,
    }));

    // byStatus counts (zonder paginatie, zonder status-filter, met search).
    const byStatus = { aangemeld: 0, aanwezig: 0, no_show: 0, sale: 0, switched_to_other_event: 0, geannuleerd: 0 };
    try {
      await Promise.all(VALID_STATUS.map(async (s) => {
        let cq = supabaseAdmin
          .from('event_attendees')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', eventId)
          .eq('is_test', false)
          .eq('status', s);
        if (search) {
          const safe = search.replace(/[%,]/g, '');
          if (safe.length > 0) {
            const pattern = `*${safe}*`;
            cq = cq.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`);
          }
        }
        const { count: c, error: ce } = await cq;
        if (ce) { console.error('[events-attendees-list count', s, ']', ce.message); return; }
        byStatus[s] = typeof c === 'number' ? c : 0;
      }));
    } catch (e) {
      console.error('[events-attendees-list byStatus]', e.message);
    }

    const total = typeof count === 'number' ? count : items.length;
    return res.status(200).json({
      items, total, limit, offset,
      counts: { byStatus },
    });
  } catch (e) {
    console.error('[events-attendees-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
