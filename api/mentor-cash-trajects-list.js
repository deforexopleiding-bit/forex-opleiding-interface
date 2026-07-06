// api/mentor-cash-trajects-list.js
// GET ?status=&mentor_user_id= → verrijkte lijst mentor_cash_trajects.
// Permission: mentor.ledger.write (zelfde als save/status).
//
// Verrijkingen per traject:
//   mentor_name        via profiles.full_name + team_members.name fallback
//   event_title        via events.title
//   released_terms     count van mentor_ledger_entries met
//                       idempotency_key LIKE 'cashtraject:<id>:term:%'
//   released_amount    som van amount van die entries
//   remaining_amount   = bonus_total - released_amount

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

  const { status, mentor_user_id } = req.query || {};

  try {
    let q = supabaseAdmin.from('mentor_cash_trajects')
      .select('id, mentor_user_id, event_id, customer_id, client_label, total_amount, term_count, pct, bonus_total, start_month, status, paused_at, created_at, note')
      .order('created_at', { ascending: false })
      .limit(500);
    if (status) q = q.eq('status', String(status));
    if (mentor_user_id) q = q.eq('mentor_user_id', String(mentor_user_id));
    const { data: trajects, error: tErr } = await q;
    if (tErr) throw new Error('trajects: ' + tErr.message);

    const rows = trajects || [];
    if (!rows.length) return res.status(200).json({ ok: true, trajects: [] });

    // Verrijking: mentor-namen.
    const mentorIds = [...new Set(rows.map(r => r.mentor_user_id).filter(Boolean))];
    const mentorName = new Map();
    if (mentorIds.length) {
      const { data: profs } = await supabaseAdmin
        .from('profiles').select('id, full_name, email').in('id', mentorIds);
      for (const p of profs || []) mentorName.set(p.id, p.full_name || p.email || '');
      // Fallback op team_members.name als profiles leeg.
      const missing = mentorIds.filter(id => !mentorName.get(id));
      if (missing.length) {
        const { data: tms } = await supabaseAdmin
          .from('team_members').select('user_id, name').in('user_id', missing);
        for (const tm of tms || []) if (!mentorName.get(tm.user_id) && tm.name) mentorName.set(tm.user_id, tm.name);
      }
    }

    // Verrijking: event-titels.
    const eventIds = [...new Set(rows.map(r => r.event_id).filter(Boolean))];
    const eventTitle = new Map();
    if (eventIds.length) {
      const { data: evs } = await supabaseAdmin
        .from('events').select('id, title, starts_at').in('id', eventIds);
      for (const e of evs || []) eventTitle.set(e.id, { title: e.title, starts_at: e.starts_at });
    }

    // Verrijking: per traject released_terms + released_amount via prefix-scan.
    // Eén bulk-query met OR-prefix zou complex zijn — één LIKE per traject
    // is 1 roundtrip per rij. Voor <500 trajects acceptabel. Als het groot
    // wordt: aparte VIEW of aggregate-endpoint.
    const results = [];
    for (const t of rows) {
      const { data: ents } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .select('amount, idempotency_key')
        .like('idempotency_key', `cashtraject:${t.id}:term:%`);
      const releasedTerms  = Array.isArray(ents) ? ents.length : 0;
      const releasedAmount = round2((ents || []).reduce((s, e) => s + (Number(e.amount) || 0), 0));
      const remaining      = round2(Number(t.bonus_total || 0) - releasedAmount);
      const evInfo = eventTitle.get(t.event_id) || null;
      results.push({
        id: t.id,
        mentor_user_id: t.mentor_user_id,
        mentor_name:    mentorName.get(t.mentor_user_id) || '',
        event_id:       t.event_id,
        event_title:    evInfo?.title || '',
        event_starts_at: evInfo?.starts_at || null,
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
        released_terms:   releasedTerms,
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
