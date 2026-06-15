// api/events-completed-list.js
//
// GET → lijst van afgeronde events (completed_at IS NOT NULL) met per event
// geaggregeerde attendance-counts, sales-count, uitgaven en bonus-verdeling
// per mentor. Nieuwste eerst (op completed_at desc).
//
// Permission: events.event.view.
//
// Response 200:
//   {
//     ok: true,
//     events: [{
//       event_id, title, starts_at, completed_at, completion_summary,
//       aanwezig, no_show, afgemeld,
//       sales,
//       expenses: [{ vendor, amount, spent_at }], expenses_total,
//       bonus_total,
//       per_mentor: [{ name, bonus, uitgave, netto }]
//     }, ...]
//   }
//
// Aggregaties:
//   - attendance: count event_attendees waar event_id matched en
//     attendance_status in (aanwezig/no_show/afgemeld)
//   - sales: count event_attendees met deal_id waar de deal accepted/signed is,
//     OF events_attendee.status = 'sale'
//   - expenses: alle event_expenses.* rows + sum
//   - bonus_total: sum(amount) over mentor_ledger_entries WHERE entry_type='bonus'
//     en status IN ('vrijgegeven','uitbetaald','pending','wachten_op_betaling')
//   - per_mentor: per mentor_user_id → bonus + uitgave + netto

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ACCEPTED = new Set(['accepted', 'signed']);
const LIMIT = 100;

function round2(n) { return Math.round(Number(n) * 100) / 100; }

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
  if (!(await requirePermission(req, 'events.event.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
  }

  try {
    // ── 1) Afgeronde events laden ────────────────────────────────────────
    const { data: events, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, completed_at, completion_summary')
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(LIMIT);
    if (evErr) throw new Error('events fetch: ' + evErr.message);
    const rows = events || [];
    if (rows.length === 0) return res.status(200).json({ ok: true, events: [] });

    const eventIds = rows.map((e) => e.id);

    // ── 2) Attendees per event (counts + sales) ──────────────────────────
    const { data: atts, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('event_id, attendance_status, status, deal_id')
      .in('event_id', eventIds);
    if (attErr) {
      console.error('[events-completed-list] attendees:', attErr.message);
    }
    // Pre-check deals zodat we 'sale' kunnen detecteren via deal-status
    const dealIds = [...new Set((atts || []).map((a) => a.deal_id).filter(Boolean))];
    const acceptedDeals = new Set();
    if (dealIds.length > 0) {
      const { data: deals } = await supabaseAdmin
        .from('deals')
        .select('id, tl_quotation_status')
        .in('id', dealIds);
      for (const d of (deals || [])) {
        if (ACCEPTED.has(String(d.tl_quotation_status || '').toLowerCase())) {
          acceptedDeals.add(d.id);
        }
      }
    }
    const attendanceByEvent = new Map();
    for (const a of (atts || [])) {
      const cell = attendanceByEvent.get(a.event_id) || { aanwezig: 0, no_show: 0, afgemeld: 0, sales: 0 };
      if (a.attendance_status === 'aanwezig') cell.aanwezig += 1;
      if (a.attendance_status === 'no_show')  cell.no_show  += 1;
      if (a.attendance_status === 'afgemeld') cell.afgemeld += 1;
      if (a.status === 'sale' || (a.deal_id && acceptedDeals.has(a.deal_id))) cell.sales += 1;
      attendanceByEvent.set(a.event_id, cell);
    }

    // ── 3) Expenses per event ────────────────────────────────────────────
    const { data: exps, error: expErr } = await supabaseAdmin
      .from('event_expenses')
      .select('event_id, vendor, amount, spent_at')
      .in('event_id', eventIds);
    if (expErr) {
      console.error('[events-completed-list] expenses:', expErr.message);
    }
    const expensesByEvent = new Map();
    for (const e of (exps || [])) {
      const list = expensesByEvent.get(e.event_id) || [];
      list.push({ vendor: e.vendor || null, amount: Number(e.amount) || 0, spent_at: e.spent_at || null });
      expensesByEvent.set(e.event_id, list);
    }

    // ── 4) Ledger entries per event (bonus + uitgave per mentor) ─────────
    const { data: ledger, error: ledErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .select('event_id, mentor_user_id, entry_type, amount, status')
      .in('event_id', eventIds);
    if (ledErr) {
      console.error('[events-completed-list] ledger:', ledErr.message);
    }
    const mentorUserIds = [...new Set((ledger || []).map((l) => l.mentor_user_id).filter(Boolean))];
    let mentorNameById = new Map();
    if (mentorUserIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from('profiles').select('id, email, full_name').in('id', mentorUserIds);
      for (const p of (profiles || [])) mentorNameById.set(p.id, p.full_name || p.email || '(onbekend)');
    }
    // per-event aggregaties
    const bonusByEvent = new Map();
    // map<event_id, map<mentor_user_id, { bonus, uitgave }>>
    const perMentorByEvent = new Map();
    for (const l of (ledger || [])) {
      const amount = Number(l.amount) || 0;
      if (l.entry_type === 'bonus') {
        bonusByEvent.set(l.event_id, round2((bonusByEvent.get(l.event_id) || 0) + amount));
      }
      const cell = perMentorByEvent.get(l.event_id) || new Map();
      const m = cell.get(l.mentor_user_id) || { bonus: 0, uitgave: 0 };
      if (l.entry_type === 'bonus')  m.bonus   += amount;
      if (l.entry_type === 'uitgave') m.uitgave += Math.abs(amount);
      cell.set(l.mentor_user_id, m);
      perMentorByEvent.set(l.event_id, cell);
    }

    // ── 5) Bouw output ──────────────────────────────────────────────────
    const out = rows.map((ev) => {
      const att = attendanceByEvent.get(ev.id) || { aanwezig: 0, no_show: 0, afgemeld: 0, sales: 0 };
      const expList = expensesByEvent.get(ev.id) || [];
      const expensesTotal = round2(expList.reduce((s, e) => s + e.amount, 0));
      const mentorMap = perMentorByEvent.get(ev.id) || new Map();
      const perMentor = Array.from(mentorMap.entries())
        .map(([mid, m]) => ({
          name   : mentorNameById.get(mid) || '(onbekend)',
          bonus  : round2(m.bonus),
          uitgave: round2(m.uitgave),
          netto  : round2(m.bonus - m.uitgave),
        }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return {
        event_id          : ev.id,
        title             : ev.title,
        starts_at         : ev.starts_at,
        completed_at      : ev.completed_at,
        completion_summary: ev.completion_summary || null,
        aanwezig          : att.aanwezig,
        no_show           : att.no_show,
        afgemeld          : att.afgemeld,
        sales             : att.sales,
        expenses          : expList,
        expenses_total    : expensesTotal,
        bonus_total       : round2(bonusByEvent.get(ev.id) || 0),
        per_mentor        : perMentor,
      };
    });

    return res.status(200).json({ ok: true, events: out });
  } catch (e) {
    console.error('[events-completed-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
