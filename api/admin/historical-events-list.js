// api/admin/historical-events-list.js
//
// GET — Lijst van historische events (is_historical=true) voor de admin-tool.
// SUPER_ADMIN, read-only. Per event: title, datum, status, aantal deals,
// aantal aanwezige mentoren, som van uitgaven, en of er al ledger-entries
// bestaan (bonus_geboekt).
//
// Response 200: { events: [{ id, title, starts_at, status, deals, mentoren,
//                            kosten, bonus_geboekt }] }
//
// Beveiliging: verifyAdmin + super_admin gate.

import { verifyAdmin, supabaseAdmin } from '../supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

  try {
    // ── 1. Events met is_historical=true ────────────────────────────────
    //    is_historical kan in oudere schema's ontbreken (historical-event-save
    //    schrijft 'm fail-soft). Bij column-not-found geeft de PostgREST
    //    error een lege lijst terug — behandel dat als 'geen historische
    //    events' i.p.v. crash.
    const { data: events, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, status, completed_at')
      .eq('is_historical', true)
      .order('starts_at', { ascending: false })
      .limit(200);

    if (evErr) {
      // 42703 = undefined_column (schema mist is_historical) → lege lijst.
      if (evErr.code === '42703') return res.status(200).json({ events: [] });
      throw new Error('events fetch: ' + evErr.message);
    }
    const rows = events || [];
    if (rows.length === 0) return res.status(200).json({ events: [] });

    const eventIds = rows.map((e) => e.id);

    // ── 2. Aggregaties per event in batch ───────────────────────────────
    //    supabase-js kent geen SQL-side GROUP BY; we tellen client-side na
    //    één brede select per tabel. Voor 200 events x weinig rows per event
    //    is dat prima. Bij grotere schaal → RPC.
    const [
      { data: attendeeRows, error: aErr },
      { data: mentorRows,   error: mErr },
      { data: expenseRows,  error: xErr },
      { data: ledgerRows,   error: lErr },
    ] = await Promise.all([
      supabaseAdmin.from('event_attendees')
        .select('event_id, deal_id, status')
        .in('event_id', eventIds),
      supabaseAdmin.from('event_mentors')
        .select('event_id, was_present')
        .in('event_id', eventIds),
      supabaseAdmin.from('event_expenses')
        .select('event_id, amount')
        .in('event_id', eventIds),
      supabaseAdmin.from('mentor_ledger_entries')
        .select('event_id')
        .in('event_id', eventIds)
        .in('entry_type', ['bonus', 'uitgave'])
        .limit(2000),
    ]);
    if (aErr) throw new Error('attendees fetch: ' + aErr.message);
    if (mErr) throw new Error('mentors fetch: '  + mErr.message);
    if (xErr) throw new Error('expenses fetch: ' + xErr.message);
    if (lErr) throw new Error('ledger fetch: '   + lErr.message);

    const dealsPerEvent   = new Map();
    const mentorsPerEvent = new Map();
    const kostenPerEvent  = new Map();
    const geboektPerEvent = new Set();

    for (const a of (attendeeRows || [])) {
      // Deal-count: alle aanwezige/koppelbare attendees met deal_id.
      if (!a.deal_id) continue;
      dealsPerEvent.set(a.event_id, (dealsPerEvent.get(a.event_id) || 0) + 1);
    }
    for (const m of (mentorRows || [])) {
      if (m.was_present !== true) continue;
      mentorsPerEvent.set(m.event_id, (mentorsPerEvent.get(m.event_id) || 0) + 1);
    }
    for (const x of (expenseRows || [])) {
      const amt = Number(x.amount) || 0;
      kostenPerEvent.set(x.event_id, (kostenPerEvent.get(x.event_id) || 0) + amt);
    }
    for (const l of (ledgerRows || [])) {
      if (l.event_id) geboektPerEvent.add(l.event_id);
    }

    const out = rows.map((e) => ({
      id            : e.id,
      title         : e.title || '(zonder titel)',
      starts_at     : e.starts_at,
      status        : e.status,
      completed_at  : e.completed_at,
      deals         : dealsPerEvent.get(e.id)   || 0,
      mentoren      : mentorsPerEvent.get(e.id) || 0,
      kosten        : Math.round((kostenPerEvent.get(e.id) || 0) * 100) / 100,
      bonus_geboekt : geboektPerEvent.has(e.id),
    }));

    return res.status(200).json({ events: out });
  } catch (e) {
    console.error('[admin/historical-events-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
