// api/events-complete.js
//
// F5.1 — Event afronden in 1 endpoint:
//   1) events.completed_at/by zetten (eerste keer; her-afronden idempotent)
//   2) per attendee: attendance_status (aanwezig/no_show/afgemeld) +
//      followup_reason (vrije tekst uit no-show dropdown)
//   3) event_mentors.was_present per opgegeven mentor zetten (rest false)
//   4) uitgaven inserten in event_expenses
//   5) ledger-entries:
//        - bonus: per AANWEZIGE attendee met sale-koppeling, voor elke
//          AANWEZIGE mentor (met user_id) → bonus-entry van 3% × deal.excl / N
//        - uitgave: som(uitgaven) / N → per AANWEZIGE mentor uitgave-entry
//          (NEGATIEF amount), direct 'vrijgegeven'
//      Idempotency via UNIQUE idempotency_key:
//        - bonus:  ${event_id}:bonus:${attendee_id}:${mentor_user_id}
//        - uitgave: ${event_id}:uitgave:${mentor_user_id}
//      Her-afronden voegt geen dubbele entries toe; 23505 → skip + log.
//
// Permission: events.event.complete (nieuwe key).
//
// Body (JSON):
//   {
//     event_id: uuid,
//     attendees: [{ attendee_id: uuid,
//                   attendance_status: 'aanwezig'|'no_show'|'afgemeld',
//                   followup_reason?: string }],
//     present_team_member_ids: uuid[],  (aanwezige mentoren — rest blijft/wordt was_present=false)
//     expenses: [{ amount: number, vendor?: string, spent_at?: 'YYYY-MM-DD',
//                  note?: string, mentor_team_member_ids?: uuid[] }],
//                  // mentor_team_member_ids: per uitgave wie mee deelt; leeg/
//                  // ontbrekend = alle aanwezige mentoren (F5.1+ herzien)
//     basis_incl_btw?: boolean,    // default true (incl. BTW); F5.1 amend
//     completion_summary?: string  // korte tekst op events.completion_summary (F5.1+ herzien)
//   }
//
// Response 200: { ok, event_id, completed_at, summary: {
//   attendees_updated, mentors_marked_present, expenses_inserted,
//   bonus_entries_created, expense_entries_created,
//   skipped: { reason: count, ... }, total_bonus_amount, total_expense_amount,
//   warnings: [..]  } }
// 400 validatie | 401/403 | 404 event | 500 DB-fout
//
// Geldtype: numeric (EUR) — match finance. Geen integer cents.
//
// Atomiciteit: Supabase REST heeft geen multi-statement transactions; we
// doen per-stap best-effort met defensieve checks vóór elke schrijfactie
// (volgorde: events → attendees → mentors → expenses → ledger). Bij DB-fout
// in een latere stap is wat al persistent is, persistent. Idempotency-key
// op ledger-entries zorgt dat opnieuw runnen geen dubbele entries maakt.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeDealTotals } from './_lib/deal-total.js';

const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATT_SET   = new Set(['aanwezig', 'no_show', 'afgemeld']);
const ACCEPTED  = new Set(['accepted', 'signed']);
const BONUS_PCT = 3;  // % van excl-BTW dealwaarde

function round2(n) { return Math.round(Number(n) * 100) / 100; }

function isDateString(s) {
  if (!s || typeof s !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.complete'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.complete)' });
  }

  // ── Body parse + basis-validatie ─────────────────────────────────────────
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : '';
  if (!eventId || !UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'event_id (uuid) vereist' });
  }
  const attendeesIn = Array.isArray(body.attendees) ? body.attendees : [];
  const presentMentorIds = Array.isArray(body.present_team_member_ids) ? body.present_team_member_ids : [];
  const expensesIn = Array.isArray(body.expenses) ? body.expenses : [];
  // F5.1 amend: bonus-grondslag incl. of excl. BTW. Default true (incl.) als
  // afwezig of null in de body — backwards-compatible voor callers die het
  // veld nog niet meesturen.
  const basisInclBtw = body.basis_incl_btw === false ? false : true;
  // F5.1+ herzien: korte samenvatting (events.completion_summary)
  const completionSummary = typeof body.completion_summary === 'string'
    ? body.completion_summary.slice(0, 5000)
    : null;

  for (const a of attendeesIn) {
    if (!a || typeof a !== 'object') return res.status(400).json({ error: 'attendees-item ongeldig' });
    if (!UUID_RE.test(String(a.attendee_id || ''))) return res.status(400).json({ error: 'attendee_id ongeldig' });
    if (!ATT_SET.has(String(a.attendance_status || ''))) {
      return res.status(400).json({ error: `attendance_status ongeldig voor ${a.attendee_id}` });
    }
  }
  for (const m of presentMentorIds) {
    if (!UUID_RE.test(String(m || ''))) return res.status(400).json({ error: 'present_team_member_ids: uuid verwacht' });
  }
  for (const e of expensesIn) {
    if (!e || typeof e !== 'object') return res.status(400).json({ error: 'expenses-item ongeldig' });
    const amt = Number(e.amount);
    if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'expense.amount moet >= 0 zijn' });
    if (e.spent_at && !isDateString(e.spent_at)) return res.status(400).json({ error: 'expense.spent_at moet YYYY-MM-DD zijn' });
    if (e.mentor_team_member_ids != null && !Array.isArray(e.mentor_team_member_ids)) {
      return res.status(400).json({ error: 'expense.mentor_team_member_ids moet array zijn' });
    }
    for (const tm of (e.mentor_team_member_ids || [])) {
      if (!UUID_RE.test(String(tm || ''))) return res.status(400).json({ error: 'expense.mentor_team_member_ids: uuid verwacht' });
    }
  }

  const summary = {
    attendees_updated      : 0,
    mentors_marked_present : 0,
    expenses_inserted      : 0,
    bonus_entries_created  : 0,
    expense_entries_created: 0,
    skipped                : {},
    total_bonus_amount     : 0,
    total_expense_amount   : 0,
    warnings               : [],
  };
  const bump = (k) => { summary.skipped[k] = (summary.skipped[k] || 0) + 1; };

  try {
    // ── 1) Event laden ─────────────────────────────────────────────────────
    const { data: event, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, status, completed_at, completed_by')
      .eq('id', eventId)
      .maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!event) return res.status(404).json({ error: 'Event niet gevonden' });

    // ── 2) events.completed_at/by + completion_summary ────────────────────
    // completed_at: idempotent (alleen zetten bij eerste keer afronden).
    // completion_summary: altijd overschrijven als er een waarde is meegestuurd
    // (ook bij her-afronden moet de samenvatting bijgewerkt kunnen worden).
    let completedAt = event.completed_at;
    const evUpdate = {};
    if (!completedAt) {
      const nowIso = new Date().toISOString();
      evUpdate.completed_at = nowIso;
      evUpdate.completed_by = user.id;
      completedAt = nowIso;
    }
    if (completionSummary != null) {
      evUpdate.completion_summary = completionSummary || null;
    }
    if (Object.keys(evUpdate).length > 0) {
      const { error: cErr } = await supabaseAdmin
        .from('events').update(evUpdate).eq('id', eventId);
      if (cErr) throw new Error('event complete update: ' + cErr.message);
    }

    // ── 3) Per attendee: status + followup_reason ──────────────────────────
    for (const a of attendeesIn) {
      const upd = { attendance_status: a.attendance_status };
      if (a.followup_reason != null) upd.followup_reason = String(a.followup_reason).slice(0, 500);
      const { error: aErr } = await supabaseAdmin
        .from('event_attendees')
        .update(upd)
        .eq('id', a.attendee_id)
        .eq('event_id', eventId);
      if (aErr) {
        console.error('[events-complete] attendee update', a.attendee_id, aErr.message);
        summary.warnings.push(`attendee ${a.attendee_id}: ${aErr.message}`);
      } else {
        summary.attendees_updated += 1;
      }
    }

    // ── 4) event_mentors.was_present voor opgegeven team_member_ids ────────
    // Strategie: alles van het event eerst op false, dan opgegeven set op true.
    {
      const { error: resetErr } = await supabaseAdmin
        .from('event_mentors')
        .update({ was_present: false })
        .eq('event_id', eventId);
      if (resetErr) {
        summary.warnings.push('mentors reset: ' + resetErr.message);
      }
      if (presentMentorIds.length > 0) {
        const { error: setErr, count } = await supabaseAdmin
          .from('event_mentors')
          .update({ was_present: true }, { count: 'exact' })
          .eq('event_id', eventId)
          .in('team_member_id', presentMentorIds);
        if (setErr) {
          summary.warnings.push('mentors mark present: ' + setErr.message);
        } else {
          summary.mentors_marked_present = count || 0;
        }
      }
    }

    // ── 5) Uitgaven inserten (incl. mentor_team_member_ids per uitgave) ───
    const expenseRows = expensesIn
      .filter((e) => Number(e.amount) > 0)
      .map((e) => ({
        event_id              : eventId,
        amount                : round2(e.amount),
        vendor                : e.vendor ? String(e.vendor).slice(0, 255) : null,
        spent_at              : e.spent_at || null,
        note                  : e.note ? String(e.note).slice(0, 1000) : null,
        mentor_team_member_ids: Array.isArray(e.mentor_team_member_ids) && e.mentor_team_member_ids.length > 0
                                  ? e.mentor_team_member_ids : null,
        created_by            : user.id,
      }));
    let insertedExpenses = [];
    if (expenseRows.length > 0) {
      const { error: exErr, data: exData } = await supabaseAdmin
        .from('event_expenses')
        .insert(expenseRows)
        .select('id, amount, mentor_team_member_ids');
      if (exErr) {
        summary.warnings.push('expenses insert: ' + exErr.message);
      } else {
        insertedExpenses = exData || [];
        summary.expenses_inserted = insertedExpenses.length;
      }
    }

    // ── 6) Bepaal "aanwezige mentoren met user_id" (basis voor ledger) ─────
    const { data: mentorsAll, error: mErr } = await supabaseAdmin
      .from('event_mentors')
      .select(`
        team_member_id, was_present,
        team_members:team_member_id ( id, user_id )
      `)
      .eq('event_id', eventId);
    if (mErr) {
      summary.warnings.push('mentors fetch (ledger): ' + mErr.message);
    }
    const presentMentors = (mentorsAll || [])
      .filter((m) => m.was_present === true)
      .map((m) => ({
        team_member_id: m.team_member_id,
        user_id       : m.team_members?.user_id || null,
      }));
    const eligibleMentors = presentMentors.filter((m) => !!m.user_id);
    if (presentMentors.length > eligibleMentors.length) {
      const missing = presentMentors.length - eligibleMentors.length;
      summary.warnings.push(`${missing} aanwezige mentor(en) zonder user_id — geen ledger-entries`);
      summary.skipped.mentor_zonder_user_id = missing;
    }
    const N = eligibleMentors.length;

    // ── 7) Ledger: bonus per aanwezige verkochte attendee ──────────────────
    if (N > 0) {
      const presentSold = attendeesIn.filter((a) => a.attendance_status === 'aanwezig');
      if (presentSold.length === 0) {
        // alleen no-show/afgemeld — niets te bonussen
      }
      // Laad alle aanwezige attendees met FK's
      const presentIds = presentSold.map((a) => a.attendee_id);
      let attendeeRows = [];
      if (presentIds.length > 0) {
        const { data, error } = await supabaseAdmin
          .from('event_attendees')
          .select('id, customer_id, deal_id')
          .in('id', presentIds);
        if (error) {
          summary.warnings.push('attendees fetch (bonus): ' + error.message);
        } else {
          attendeeRows = data || [];
        }
      }

      for (const att of attendeeRows) {
        // 7a) Zoek getekende deal
        let deal = null;
        if (att.deal_id) {
          const { data: d } = await supabaseAdmin
            .from('deals')
            .select('id, customer_id, discount_percentage, sale_type, tl_quotation_status, tl_quotation_accepted_at')
            .eq('id', att.deal_id)
            .maybeSingle();
          if (d && (ACCEPTED.has(String(d.tl_quotation_status || '').toLowerCase()) || d.tl_quotation_accepted_at)) {
            deal = d;
          }
        }
        if (!deal && att.customer_id) {
          const { data: ds } = await supabaseAdmin
            .from('deals')
            .select('id, customer_id, discount_percentage, sale_type, tl_quotation_status, tl_quotation_accepted_at')
            .eq('customer_id', att.customer_id)
            .in('tl_quotation_status', ['accepted', 'signed'])
            .order('tl_quotation_accepted_at', { ascending: false, nullsFirst: false })
            .limit(1);
          if (ds && ds[0]) deal = ds[0];
        }
        if (!deal) { bump('attendee_zonder_getekende_offerte'); continue; }

        // 7b) Totaal berekenen
        const { data: lines } = await supabaseAdmin
          .from('deal_line_items')
          .select('quantity, unit_price, vat_percentage, price_includes_vat')
          .eq('deal_id', deal.id);
        const totals = computeDealTotals(deal, lines || []);
        const basis = basisInclBtw ? totals.incl : totals.excl; // F5.1: per-event toggle
        if (!Number.isFinite(basis) || basis <= 0) { bump('deal_zonder_waarde'); continue; }

        // 7c) Per mentor één bonus-entry (idempotent)
        const perMentor = round2((BONUS_PCT * basis / 100) / N);
        if (perMentor <= 0) { bump('bonus_afgerond_naar_nul'); continue; }
        for (const m of eligibleMentors) {
          const idem = `${eventId}:bonus:${att.id}:${m.user_id}`;
          const { error: insErr } = await supabaseAdmin
            .from('mentor_ledger_entries')
            .insert({
              mentor_user_id : m.user_id,
              team_member_id : m.team_member_id,
              event_id       : eventId,
              entry_type     : 'bonus',
              attendee_id    : att.id,
              customer_id    : deal.customer_id || att.customer_id || null,
              basis          : basis,
              basis_incl_btw : basisInclBtw,
              pct            : BONUS_PCT,
              amount         : perMentor,
              status         : 'pending',
              source_quote_id: deal.id,
              idempotency_key: idem,
              note           : `Bonus ${BONUS_PCT}% van EUR ${basis.toFixed(2)} ${basisInclBtw ? 'incl' : 'excl'} BTW / ${N} mentor(en)`,
            });
          if (insErr) {
            if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
              bump('bonus_al_aangemaakt');
            } else {
              console.error('[events-complete] bonus insert', insErr.message);
              summary.warnings.push('bonus insert: ' + insErr.message);
            }
          } else {
            summary.bonus_entries_created += 1;
            summary.total_bonus_amount = round2(summary.total_bonus_amount + perMentor);
          }
        }
      }

      // ── 8) Ledger: per uitgave splitsen over de aangewezen mentoren ──────
      // Per expense kan een lijst mentor_team_member_ids meekomen. Leeg →
      // verdelen over alle aanwezige mentoren met user_id (= huidige eligible).
      // Anders: filter eligibleMentors op die team_member_ids.
      // Idempotency-key per (event, expense_id, mentor_user_id) — bij her-
      // afronden ontstaan nieuwe expense-ids, dus nieuwe ledger-entries.
      const releasedAt = new Date().toISOString();
      for (const exp of insertedExpenses) {
        const explicitIds = Array.isArray(exp.mentor_team_member_ids) ? exp.mentor_team_member_ids : null;
        const targetMentors = (explicitIds && explicitIds.length > 0)
          ? eligibleMentors.filter((m) => explicitIds.includes(m.team_member_id))
          : eligibleMentors;
        if (targetMentors.length === 0) {
          bump('uitgave_zonder_mentor');
          continue;
        }
        const amountAbs = Number(exp.amount) || 0;
        const perMentor = -round2(amountAbs / targetMentors.length);
        if (perMentor === 0) { bump('uitgave_afgerond_naar_nul'); continue; }
        for (const m of targetMentors) {
          const idem = `${eventId}:uitgave:${exp.id}:${m.user_id}`;
          const { error: insErr } = await supabaseAdmin
            .from('mentor_ledger_entries')
            .insert({
              mentor_user_id : m.user_id,
              team_member_id : m.team_member_id,
              event_id       : eventId,
              entry_type     : 'uitgave',
              basis          : amountAbs,
              pct            : null,
              amount         : perMentor,
              status         : 'vrijgegeven',
              idempotency_key: idem,
              note           : `Aandeel uitgave EUR ${amountAbs.toFixed(2)} / ${targetMentors.length} mentor(en)`,
              released_at    : releasedAt,
            });
          if (insErr) {
            if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
              bump('uitgave_al_aangemaakt');
            } else {
              console.error('[events-complete] uitgave insert', insErr.message);
              summary.warnings.push('uitgave insert: ' + insErr.message);
            }
          } else {
            summary.expense_entries_created += 1;
            summary.total_expense_amount = round2(summary.total_expense_amount + Math.abs(perMentor));
          }
        }
      }
    } else if (presentMentorIds.length > 0) {
      summary.warnings.push('Geen mentoren met user_id — ledger overgeslagen');
    }

    return res.status(200).json({
      ok          : true,
      event_id    : eventId,
      completed_at: completedAt,
      summary,
    });
  } catch (e) {
    console.error('[events-complete] fatal:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout', summary });
  }
}
