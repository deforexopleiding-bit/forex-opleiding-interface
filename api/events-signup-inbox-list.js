// api/events-signup-inbox-list.js
// GET -> lijst van alle event-inschrijvingen voor de tab "Inschrijvingen".
//
// Sessie-JWT + RBAC events.attendee.create (zelfde permission als
// /api/events-attendee-add, omdat de resolve-actie effectief een
// attendee aanmaakt vanuit een inbox-rij).
//
// BRON (sinds 2026-09-26): een UNION van twee tabellen, zodat elke
// inschrijving precies één keer verschijnt.
//   1. event_attendees (is_test=false) — de echte bron van waarheid, ÁLLE
//      kanalen: website, event-1/2, keuzepagina, vragenlijst, CSV-backfill en
//      toekomstige flows. Heeft de attendee een inbox-rij (oude GHL-webhook),
//      dan nemen we id / status / label / ontvangstdatum van die inbox-rij
//      over — zo blijft een 'ambiguous'-rij in de Ambigu-queue én oplosbaar
//      via events-signup-inbox-resolve (die verwacht het inbox-id).
//   2. event_signup_inbox-rijen ZONDER bestaande attendee: de probleem-queues
//      (ambiguous / no_match / invalid_payload) plus matched-rijen waarvan de
//      attendee is verwijderd. Die laatste worden ge-dedupet op
//      (email + event) tegen de attendees, zodat niets dubbel telt.
// Vroeger las deze lijst alléén event_signup_inbox, die sinds FASE 1 (eigen
// website-flow, 2026-09-07) niet meer gevuld wordt — nieuwe aanmeldingen
// verschenen daardoor niet meer.
//
// Query:
//   ?status=matched|ambiguous|no_match|invalid_payload   (optioneel; default all)
//   ?limit=<1-200>                                       (default 50)
//   ?offset=<0+>                                         (default 0)
//
// Response 200 (vorm ongewijzigd, extra velden attendee_status / kanaal):
//   { rows: [{ id, source, kanaal, received_at, match_status, ghl_contact_id,
//              ghl_form_submission_id, event_date_label, first_name,
//              last_name, email, phone, matched_event_id, matched_attendee_id,
//              match_candidate_ids, resolved_at, notes, attendee_status,
//              questionnaire_filled, questionnaire_filled_at,
//              matched_event: { id, title, starts_at, niveau, capacity, signups_closed } | null }],
//     counts: { matched, ambiguous, no_match, invalid_payload, total },
//     limit, offset }
//
// `id` = inbox-id als er een inbox-rij bij hoort, anders 'attendee:<uuid>'.
// Alleen inbox-ids kunnen naar de resolve-flow; attendee-rijen zijn altijd
// 'matched' of erven de status van hun inbox-rij.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ALLOWED_STATUSES = ['matched', 'ambiguous', 'no_match', 'invalid_payload'];
const PAGE = 1000;   // PostgREST-maximum per request
const CHUNK = 150;   // ids per .in()-query (URL-lengte)

async function haalAlles(bouw) {
  const rijen = [];
  for (let van = 0; ; van += PAGE) {
    const { data, error } = await bouw().range(van, van + PAGE - 1);
    if (error) throw new Error(error.message);
    rijen.push(...(data || []));
    if (!data || data.length < PAGE) return rijen;
  }
}

async function haalPerChunk(ids, bouw) {
  const rijen = [];
  const lijst = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < lijst.length; i += CHUNK) {
    const { data, error } = await bouw(lijst.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    rijen.push(...(data || []));
  }
  return rijen;
}

const normEmail = (e) => String(e || '').trim().toLowerCase();

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
    // ── 1) Beide bronnen volledig ophalen (volume: honderden rijen) ────────
    const [attendees, inbox] = await Promise.all([
      haalAlles(() => supabaseAdmin.from('event_attendees')
        .select('id, event_id, first_name, last_name, email, phone, status, created_at, registered_at, created_via, source, assessment_response_id')
        .eq('is_test', false)
        .order('created_at', { ascending: true })),
      haalAlles(() => supabaseAdmin.from('event_signup_inbox')
        .select(`id, source, received_at, match_status, ghl_contact_id, ghl_form_submission_id,
                 event_date_label, first_name, last_name, email, phone,
                 matched_event_id, matched_attendee_id, match_candidate_ids,
                 resolved_at, resolved_by_user_id, notes`)
        .order('received_at', { ascending: true })),
    ]);

    // ── 2) Inbox-rij per attendee (1:1 geverifieerd; bij meerdere: jongste) ─
    const attendeeById = new Map(attendees.map((a) => [a.id, a]));
    const inboxByAttendee = new Map();
    for (const r of inbox) {
      if (r.matched_attendee_id && attendeeById.has(r.matched_attendee_id)) {
        inboxByAttendee.set(r.matched_attendee_id, r);   // ascending → laatste wint
      }
    }
    // Dedup-sleutel voor losse inbox-rijen: (email + event) van elke attendee.
    const attendeeKeys = new Set(
      attendees.filter((a) => a.email && a.event_id).map((a) => `${normEmail(a.email)}|${a.event_id}`),
    );

    // ── 3) Union opbouwen ──────────────────────────────────────────────────
    const unified = [];
    for (const a of attendees) {
      const ib = inboxByAttendee.get(a.id) || null;
      unified.push({
        id                    : ib ? ib.id : `attendee:${a.id}`,
        source                : ib ? ib.source : (a.source || a.created_via || null),
        kanaal                : a.created_via || null,
        received_at           : ib ? ib.received_at : (a.registered_at || a.created_at),
        match_status          : ib ? ib.match_status : 'matched',
        ghl_contact_id        : ib ? ib.ghl_contact_id : null,
        ghl_form_submission_id: ib ? ib.ghl_form_submission_id : null,
        event_date_label      : ib ? ib.event_date_label : null,
        first_name            : a.first_name,
        last_name             : a.last_name,
        email                 : a.email,
        phone                 : a.phone,
        matched_event_id      : a.event_id,
        matched_attendee_id   : a.id,
        match_candidate_ids   : ib ? ib.match_candidate_ids : null,
        resolved_at           : ib ? ib.resolved_at : null,
        resolved_by_user_id   : ib ? ib.resolved_by_user_id : null,
        notes                 : ib ? ib.notes : null,
        attendee_status       : a.status || null,
        _assessment_response_id: a.assessment_response_id || null,
      });
    }
    let dedupedInbox = 0;
    for (const r of inbox) {
      if (r.matched_attendee_id && attendeeById.has(r.matched_attendee_id)) continue; // zit al in de attendee-tak
      if (r.email && r.matched_event_id && attendeeKeys.has(`${normEmail(r.email)}|${r.matched_event_id}`)) {
        dedupedInbox += 1;   // zelfde persoon + event bestaat al als attendee
        continue;
      }
      unified.push({
        ...r,
        kanaal: r.source || null,
        matched_attendee_id: null,   // verwijzing naar een niet-bestaande attendee niet doorgeven
        attendee_status: null,
        _assessment_response_id: null,
      });
    }

    // ── 4) Tellingen over de hele union ────────────────────────────────────
    const counts = { matched: 0, ambiguous: 0, no_match: 0, invalid_payload: 0, total: 0 };
    for (const r of unified) {
      counts.total++;
      if (counts[r.match_status] != null) counts[r.match_status]++;
    }

    // ── 5) Filter + sorteren (nieuwste eerst) + pagina ─────────────────────
    const gefilterd = statusParam ? unified.filter((r) => r.match_status === statusParam) : unified;
    gefilterd.sort((x, y) => String(y.received_at || '').localeCompare(String(x.received_at || '')));
    const pagina = gefilterd.slice(offset, offset + limit);

    // ── 6) Verrijken: event + vragenlijst (alleen voor deze pagina) ────────
    const eventRows = await haalPerChunk(pagina.map((r) => r.matched_event_id), (ids) =>
      supabaseAdmin.from('events')
        .select('id, title, starts_at, ends_at, niveau, capacity, signups_closed, status')
        .in('id', ids));
    const eventById = new Map(eventRows.map((e) => [e.id, e]));

    // Vragenlijst: oude flow via assessment_responses, nieuwe flow (FASE 1)
    // via event_kwalificatie_submissions. Fail-soft: bij een fout → niet ingevuld.
    const filledAtByAttendee = new Map();
    try {
      const respIds = pagina.map((r) => r._assessment_response_id).filter(Boolean);
      const resp = await haalPerChunk(respIds, (ids) =>
        supabaseAdmin.from('assessment_responses').select('id, submitted_at, created_at').in('id', ids));
      const respAt = new Map(resp.map((r) => [r.id, r.submitted_at || r.created_at || null]));
      for (const r of pagina) {
        if (r._assessment_response_id && respAt.has(r._assessment_response_id)) {
          filledAtByAttendee.set(r.matched_attendee_id, respAt.get(r._assessment_response_id));
        }
      }
      const attIds = pagina.map((r) => r.matched_attendee_id).filter(Boolean);
      const subs = await haalPerChunk(attIds, (ids) =>
        supabaseAdmin.from('event_kwalificatie_submissions').select('attendee_id, created_at').in('attendee_id', ids));
      for (const s of subs) {
        if (!filledAtByAttendee.has(s.attendee_id)) filledAtByAttendee.set(s.attendee_id, s.created_at || null);
      }
    } catch (e) {
      console.error('[events-signup-inbox-list questionnaire-fetch]', e?.message || e);
    }

    const rows = pagina.map(({ _assessment_response_id, ...r }) => ({
      ...r,
      matched_event           : r.matched_event_id ? (eventById.get(r.matched_event_id) || null) : null,
      questionnaire_filled    : !!(r.matched_attendee_id && filledAtByAttendee.has(r.matched_attendee_id)),
      questionnaire_filled_at : r.matched_attendee_id ? (filledAtByAttendee.get(r.matched_attendee_id) || null) : null,
    }));

    return res.status(200).json({
      rows,
      counts,
      limit,
      offset,
      status_filter: statusParam || null,
      bron: { attendees: attendees.length, inbox: inbox.length, inbox_zonder_attendee_ontdubbeld: dedupedInbox },
    });
  } catch (e) {
    console.error('[events-signup-inbox-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
