// api/mentor-cash-trajects-list.js
// GET ?status=&event_id= → verrijkte lijst mentor_cash_trajects (event-driven).
// Permission: mentor.ledger.write.
//
// Verrijkingen per traject:
//   event_title / event_starts_at    via events
//   mentor_names[]                   namen van event_mentors.was_present=true
//                                    (met team_members.name); "verdeeld over N
//                                    aanwezige mentoren"
//   released_terms                   DISTINCTE termijn-indices uit
//                                    idempotency_key LIKE 'cashtraject:<id>:term:%'
//   released_amount                  som van alle entry-amounts (over mentoren)
//   remaining_amount                 = bonus_total - released_amount

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function distinctTermIndices(keys) {
  const idx = new Set();
  for (const k of keys) {
    const m = /:term:(\d+)(?:$|:)/.exec(String(k || ''));
    if (m) idx.add(Number(m[1]));
  }
  return idx.size;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.ledger.write'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.ledger.write)' });
  }

  const { status, event_id } = req.query || {};

  try {
    let q = supabaseAdmin.from('mentor_cash_trajects')
      .select('id, event_id, customer_id, client_label, total_amount, term_count, pct, bonus_total, start_month, status, paused_at, created_at, note')
      .order('created_at', { ascending: false })
      .limit(500);
    if (status)   q = q.eq('status', String(status));
    if (event_id) q = q.eq('event_id', String(event_id));
    const { data: trajects, error: tErr } = await q;
    if (tErr) throw new Error('trajects: ' + tErr.message);

    const rows = trajects || [];
    if (!rows.length) return res.status(200).json({ ok: true, trajects: [] });

    // Event-titels.
    const eventIds = [...new Set(rows.map(r => r.event_id).filter(Boolean))];
    const eventInfo = new Map();
    if (eventIds.length) {
      const { data: evs } = await supabaseAdmin
        .from('events').select('id, title, starts_at').in('id', eventIds);
      for (const e of evs || []) eventInfo.set(e.id, { title: e.title, starts_at: e.starts_at });
    }

    // Aanwezige mentoren per event (was_present=true met user_id).
    // Één bulk-query over alle unieke event-ids; groeperen per event.
    const mentorsByEvent = new Map();
    if (eventIds.length) {
      const { data: emAll } = await supabaseAdmin
        .from('event_mentors')
        .select(`event_id, was_present,
                 team_members:team_member_id ( id, name, user_id )`)
        .in('event_id', eventIds)
        .eq('was_present', true);
      for (const em of emAll || []) {
        const uid = em.team_members?.user_id;
        if (!uid) continue;
        const list = mentorsByEvent.get(em.event_id) || [];
        list.push(em.team_members?.name || '');
        mentorsByEvent.set(em.event_id, list);
      }
    }

    // Per traject: keys ophalen voor distinct term-telling + released_amount.
    const results = [];
    for (const t of rows) {
      const { data: ents } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .select('amount, idempotency_key')
        .like('idempotency_key', `cashtraject:${t.id}:term:%`);
      const keys = (ents || []).map(e => e.idempotency_key);
      const releasedTerms  = distinctTermIndices(keys);
      const releasedAmount = round2((ents || []).reduce((s, e) => s + (Number(e.amount) || 0), 0));
      const remaining      = round2(Number(t.bonus_total || 0) - releasedAmount);
      const ev = eventInfo.get(t.event_id) || null;
      const mentorNames = mentorsByEvent.get(t.event_id) || [];
      results.push({
        id: t.id,
        event_id:       t.event_id,
        event_title:    ev?.title || '',
        event_starts_at: ev?.starts_at || null,
        mentor_names:   mentorNames,             // namen van aanwezige mentoren van dit event
        mentor_count:   mentorNames.length,
        customer_id:    t.customer_id,
        client_label:   t.client_label,
        total_amount:   Number(t.total_amount),
        term_count:     Number(t.term_count),
        pct:            Number(t.pct),
        bonus_total:    Number(t.bonus_total),
        start_month:    t.start_month,
        status:         t.status,
        paused_at:      t.paused_at,
        note:           t.note,
        released_terms:   releasedTerms,          // distincte termijnen
        released_amount:  releasedAmount,
        remaining_amount: remaining,
        created_at:     t.created_at,
      });
    }

    return res.status(200).json({ ok: true, trajects: results });
  } catch (e) {
    console.error('[mentor-cash-trajects-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
