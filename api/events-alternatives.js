// api/events-alternatives.js
// GET -> gedeelde service voor "alternatieve events" suggesties.
//
// Wordt gebruikt door F1 (attendee 'switch to other event'), F3 (recommendation
// engine bij no-show) en F4 (mismatch follow-up). Daarom is dit een
// stand-alone endpoint met expliciet contract.
//
// Permission: events.event.view.
//
// Query-params:
//   source_event_id   uuid optional  (uitsluiten + default niveau-bron)
//   niveau            string optional (slug; expliciet niveau-filter)
//   min_seats         int default 1, range 1..100  (capacity - active >= min_seats)
//   max_results       int default 5, range 1..20
//   starts_after      ISO default now()
//   starts_before     ISO default now()+90d
//
// >>> FIX 2 — niveau-precedentie (KRITISCH) <<<
// Effectief niveau wordt IN APP-CODE geresolved in deze volgorde:
//   1. Als 'niveau' query-param expliciet meegegeven -> gebruik DIE waarde.
//   2. Anders als 'source_event_id' meegegeven -> fetch source en gebruik source.niveau.
//   3. Anders -> NULL = ongefilterd (alle niveaus).
// Daarna gebruiken we DEZE ENE WAARDE in de SQL-filter. GEEN OR-keten op
// 'niveau = $niveau OR niveau = (SELECT niveau FROM source)' — dat lekt
// source-niveau erbij als beide leeg lijken.
//
// Response:
//   {
//     filter_applied: {
//       niveau, min_seats, max_results, starts_after, starts_before, excluded_event_id
//     },
//     alternatives: [
//       {
//         id, title, starts_at, ends_at, location, capacity, niveau, niveau_label,
//         active_attendees, seats_remaining
//       }, ...
//     ]
//   }
//
// Error codes:
//   400 INVALID_NIVEAU / INVALID_RANGE / INVALID_UUID
//   401 UNAUTHORIZED
//   403 FORBIDDEN
//   404 SOURCE_EVENT_NOT_FOUND
//   500 LOOKUP_FAILED

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = ['aangemeld', 'aanwezig', 'sale'];

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function parseIsoOr(s, fallback) {
  if (s == null) return fallback;
  const d = new Date(String(s));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // ---- Auth ----
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ code: 'UNAUTHORIZED', error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.view'))) {
    return res.status(403).json({ code: 'FORBIDDEN', error: 'Geen rechten (events.event.view)' });
  }

  // ---- Query-param parsing ----
  const q = req.query || {};

  const sourceEventId = q.source_event_id ? String(q.source_event_id) : null;
  if (sourceEventId && !UUID_RE.test(sourceEventId)) {
    return res.status(400).json({ code: 'INVALID_UUID', error: 'source_event_id moet uuid zijn' });
  }

  const niveauParam = q.niveau ? String(q.niveau).trim().toLowerCase() : null;
  if (niveauParam != null && niveauParam.length === 0) {
    return res.status(400).json({ code: 'INVALID_NIVEAU', error: 'niveau mag niet leeg zijn als opgegeven' });
  }

  // Range-validatie: min_seats 1..100, max_results 1..20
  const minSeatsRaw  = q.min_seats   != null ? Number(q.min_seats)   : 1;
  const maxResultsRaw = q.max_results != null ? Number(q.max_results) : 5;
  if (!Number.isFinite(minSeatsRaw)  || minSeatsRaw  < 1  || minSeatsRaw  > 100) {
    return res.status(400).json({ code: 'INVALID_RANGE', error: 'min_seats moet 1..100 zijn' });
  }
  if (!Number.isFinite(maxResultsRaw) || maxResultsRaw < 1 || maxResultsRaw > 20) {
    return res.status(400).json({ code: 'INVALID_RANGE', error: 'max_results moet 1..20 zijn' });
  }
  const minSeats   = Math.trunc(minSeatsRaw);
  const maxResults = Math.trunc(maxResultsRaw);

  // Tijdvenster: default = now() .. now()+90d
  const nowIso         = new Date().toISOString();
  const ninetyDaysIso  = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  const startsAfter    = parseIsoOr(q.starts_after,  nowIso);
  const startsBefore   = parseIsoOr(q.starts_before, ninetyDaysIso);
  if (startsAfter === null) {
    return res.status(400).json({ code: 'INVALID_RANGE', error: 'starts_after moet ISO 8601 datetime zijn' });
  }
  if (startsBefore === null) {
    return res.status(400).json({ code: 'INVALID_RANGE', error: 'starts_before moet ISO 8601 datetime zijn' });
  }
  if (new Date(startsBefore) <= new Date(startsAfter)) {
    return res.status(400).json({ code: 'INVALID_RANGE', error: 'starts_before moet > starts_after zijn' });
  }

  try {
    // ---- FIX 2: effectief niveau resolven in APP-CODE ----
    // Volgorde:
    //   1. Expliciete query-param 'niveau' wint.
    //   2. Anders source_event_id -> source.niveau.
    //   3. Anders NULL (ongefilterd).
    let effectiveNiveau = null;
    let sourceEvent = null;

    if (sourceEventId) {
      const { data: src, error: srcErr } = await supabaseAdmin
        .from('events')
        .select('id, niveau')
        .eq('id', sourceEventId)
        .maybeSingle();
      if (srcErr) {
        console.error('[events-alternatives source-fetch]', srcErr.message);
        return res.status(500).json({ code: 'LOOKUP_FAILED', error: 'source-event lookup faalde' });
      }
      if (!src) {
        return res.status(404).json({ code: 'SOURCE_EVENT_NOT_FOUND', error: 'source_event_id verwijst niet naar bestaand event' });
      }
      sourceEvent = src;
    }

    if (niveauParam) {
      // Validatie: bestaat als actieve slug?
      const { data: niveauRow, error: niveauErr } = await supabaseAdmin
        .from('event_niveau_options')
        .select('slug, is_active')
        .eq('slug', niveauParam)
        .maybeSingle();
      if (niveauErr) {
        console.error('[events-alternatives niveau-lookup]', niveauErr.message);
        return res.status(500).json({ code: 'LOOKUP_FAILED', error: 'niveau-validatie faalde' });
      }
      if (!niveauRow || !niveauRow.is_active) {
        return res.status(400).json({ code: 'INVALID_NIVEAU', error: `niveau '${niveauParam}' bestaat niet of is inactief` });
      }
      effectiveNiveau = niveauParam;
    } else if (sourceEvent) {
      effectiveNiveau = sourceEvent.niveau || null;
    } else {
      effectiveNiveau = null;
    }

    // ---- SQL-query met EEN niveau-waarde (geen OR-keten) ----
    // Ik gebruik PostgREST-builder, dus geen $effective_niveau interpolatie maar
    // .eq() vs niets afhankelijk van of effectiveNiveau != null.
    let query = supabaseAdmin
      .from('events')
      .select(`
        id, title, starts_at, ends_at, location, capacity, niveau,
        event_niveau_options:niveau ( slug, label )
      `)
      .eq('status', 'published')
      .gt('starts_at', startsAfter)
      .lt('starts_at', startsBefore)
      .order('starts_at', { ascending: true })
      // Haal extra rijen op zodat we na seat-filtering nog genoeg overhouden voor max_results.
      .limit(maxResults * 4);

    if (sourceEventId) query = query.neq('id', sourceEventId);

    // >>> KEY FIX 2 <<< — exact ene-waarde-filter, geen OR-keten.
    if (effectiveNiveau) query = query.eq('niveau', effectiveNiveau);
    // Als effectiveNiveau NULL is = ongefilterd, geen extra clause.

    const { data: rows, error } = await query;
    if (error) {
      console.error('[events-alternatives list]', error.message);
      return res.status(500).json({ code: 'LOOKUP_FAILED', error: error.message });
    }

    const candidateIds = (rows || []).map((r) => r.id);
    const activeCountById = new Map();
    if (candidateIds.length > 0) {
      // Per event count actieve attendees (parallel). Voor F1 acceptabel; verfijnen
      // naar 1 group-by query met RPC kan later.
      await Promise.all(candidateIds.map(async (eid) => {
        try {
          const { count } = await supabaseAdmin
            .from('event_attendees')
            .select('id', { count: 'exact', head: true })
            .eq('event_id', eid)
            .in('status', ACTIVE_STATUSES);
          activeCountById.set(eid, typeof count === 'number' ? count : 0);
        } catch (e) {
          console.error('[events-alternatives count]', eid, e.message);
          activeCountById.set(eid, 0);
        }
      }));
    }

    const alternatives = [];
    for (const r of rows || []) {
      const active = activeCountById.get(r.id) || 0;
      const seatsRemaining = Math.max(0, (r.capacity || 0) - active);
      if (seatsRemaining < minSeats) continue;
      alternatives.push({
        id:               r.id,
        title:            r.title,
        starts_at:        r.starts_at,
        ends_at:          r.ends_at,
        location:         r.location,
        capacity:         r.capacity,
        niveau:           r.niveau,
        niveau_label:     r.event_niveau_options?.label || null,
        active_attendees: active,
        seats_remaining:  seatsRemaining,
      });
      if (alternatives.length >= maxResults) break;
    }

    return res.status(200).json({
      filter_applied: {
        niveau:            effectiveNiveau,
        min_seats:         minSeats,
        max_results:       maxResults,
        starts_after:      startsAfter,
        starts_before:     startsBefore,
        excluded_event_id: sourceEventId,
      },
      alternatives,
    });
  } catch (e) {
    console.error('[events-alternatives]', e.message);
    return res.status(500).json({ code: 'LOOKUP_FAILED', error: e.message });
  }
}
