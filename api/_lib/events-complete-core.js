// api/_lib/events-complete-core.js
//
// Fase 2b-2 — geëxtraheerde motor van api/events-complete.js. Bevat alle
// mutation-logic (event.completed_at update, attendee attendance/outcome,
// event_followups upsert, event_mentors was_present, event_expenses insert,
// bonus + uitgave ledger-entries, notifications). Gebruikt door:
//   - api/events-complete.js               (reguliere afronding, JWT-user)
//   - api/admin/historical-event-commit.js (historisch event → bonus, super_admin)
//
// GEEN auth/permission-check hier — caller doet dat. Pure functie op
// supabaseAdmin + userId (voor completed_by / created_by / added_by).
//
// Signature: runEventsCompleteCore({ userId, body }) → { statusCode, response }
// waar response de bestaande shape van events-complete uit-behoudt.

import { supabaseAdmin } from '../supabase.js';
import { computeDealTotals } from './deal-total.js';
import { createNotification } from './notify.js';

const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATT_SET     = new Set(['aanwezig', 'no_show', 'afgemeld']);
const OUTCOME_SET = new Set([
  'opvolgen', 'geen_interesse', 'nog_onbekend',
  // Uitgebreid in Blok B: sale-koppeling + twijfel-vervolg. Beide leiden
  // NIET automatisch tot bonus-verandering; alleen 'opvolgen' + 'twijfelt_nog'
  // triggeren een follow-up (met verplichte notitie).
  'klant_geworden', 'twijfelt_nog',
]);
// Outcomes waarvoor een follow-up-record aangemaakt/bijgewerkt moet worden.
// no_show is een aparte status, niet een outcome; die trigger blijft in
// de aanvullende conditie hieronder staan.
const FOLLOWUP_OUTCOMES = new Set(['opvolgen', 'twijfelt_nog']);
// Outcomes waarbij server-side notitie (followup.reason) verplicht is.
const REASON_REQUIRED_OUTCOMES = new Set(['opvolgen', 'twijfelt_nog']);
const ACCEPTED    = new Set(['accepted', 'signed']);
const BONUS_PCT   = 3;
const DEFAULT_FOLLOWUP_OWNER_ID = process.env.DEFAULT_EVENT_FOLLOWUP_OWNER_ID || null;

export { BONUS_PCT };

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function isDateString(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

/**
 * @param {object} args
 * @param {string} args.userId  auth-user-id voor completed_by / created_by
 * @param {object} args.body    dezelfde body-shape als api/events-complete.js
 * @returns {Promise<{ statusCode: number, response: object }>}
 */
export async function runEventsCompleteCore({ userId, body }) {
  if (!userId) return { statusCode: 400, response: { error: 'userId vereist' } };
  if (!body || typeof body !== 'object') return { statusCode: 400, response: { error: 'Body ontbreekt' } };

  const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : '';
  if (!eventId || !UUID_RE.test(eventId)) {
    return { statusCode: 400, response: { error: 'event_id (uuid) vereist' } };
  }
  const attendeesIn      = Array.isArray(body.attendees) ? body.attendees : [];
  const presentMentorIds = Array.isArray(body.present_team_member_ids) ? body.present_team_member_ids : [];
  const expensesIn       = Array.isArray(body.expenses) ? body.expenses : [];
  const basisInclBtw     = body.basis_incl_btw === false ? false : true;
  const completionSummary = typeof body.completion_summary === 'string'
    ? body.completion_summary.slice(0, 5000)
    : null;

  for (const a of attendeesIn) {
    if (!a || typeof a !== 'object') return { statusCode: 400, response: { error: 'attendees-item ongeldig' } };
    if (!UUID_RE.test(String(a.attendee_id || ''))) return { statusCode: 400, response: { error: 'attendee_id ongeldig' } };
    if (!ATT_SET.has(String(a.attendance_status || ''))) {
      return { statusCode: 400, response: { error: `attendance_status ongeldig voor ${a.attendee_id}` } };
    }
    if (a.outcome != null) {
      if (!OUTCOME_SET.has(String(a.outcome))) {
        return { statusCode: 400, response: { error: `outcome ongeldig voor ${a.attendee_id}` } };
      }
      if (a.attendance_status !== 'aanwezig') {
        return { statusCode: 400, response: { error: `outcome alleen toegestaan bij attendance_status='aanwezig' (${a.attendee_id})` } };
      }
    }
    if (a.followup != null) {
      if (typeof a.followup !== 'object' || Array.isArray(a.followup)) {
        return { statusCode: 400, response: { error: `followup moet object zijn voor ${a.attendee_id}` } };
      }
      if (a.followup.follow_up_date && !isDateString(a.followup.follow_up_date)) {
        return { statusCode: 400, response: { error: `followup.follow_up_date moet YYYY-MM-DD zijn (${a.attendee_id})` } };
      }
      if (a.followup.owner_id != null && !UUID_RE.test(String(a.followup.owner_id))) {
        return { statusCode: 400, response: { error: `followup.owner_id ongeldig (${a.attendee_id})` } };
      }
    }
  }
  for (const m of presentMentorIds) {
    if (!UUID_RE.test(String(m || ''))) return { statusCode: 400, response: { error: 'present_team_member_ids: uuid verwacht' } };
  }
  for (const e of expensesIn) {
    if (!e || typeof e !== 'object') return { statusCode: 400, response: { error: 'expenses-item ongeldig' } };
    const amt = Number(e.amount);
    if (!Number.isFinite(amt) || amt < 0) return { statusCode: 400, response: { error: 'expense.amount moet >= 0 zijn' } };
    if (e.spent_at && !isDateString(e.spent_at)) return { statusCode: 400, response: { error: 'expense.spent_at moet YYYY-MM-DD zijn' } };
    if (e.mentor_team_member_ids != null && !Array.isArray(e.mentor_team_member_ids)) {
      return { statusCode: 400, response: { error: 'expense.mentor_team_member_ids moet array zijn' } };
    }
    for (const tm of (e.mentor_team_member_ids || [])) {
      if (!UUID_RE.test(String(tm || ''))) return { statusCode: 400, response: { error: 'expense.mentor_team_member_ids: uuid verwacht' } };
    }
  }

  const summary = {
    attendees_updated      : 0,
    mentors_marked_present : 0,
    expenses_inserted      : 0,
    bonus_entries_created  : 0,
    expense_entries_created: 0,
    followups_created      : 0,
    followups_updated      : 0,
    skipped                : {},
    total_bonus_amount     : 0,
    total_expense_amount   : 0,
    warnings               : [],
  };
  const bump = (k) => { summary.skipped[k] = (summary.skipped[k] || 0) + 1; };

  try {
    // ── 1) Event laden ──────────────────────────────────────────────────────
    const { data: event, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, status, completed_at, completed_by')
      .eq('id', eventId)
      .maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!event) return { statusCode: 404, response: { error: 'Event niet gevonden' } };

    // ── 2) events.completed_at/by + completion_summary ──────────────────────
    let completedAt = event.completed_at;
    const evUpdate = {};
    if (!completedAt) {
      const nowIso = new Date().toISOString();
      evUpdate.completed_at = nowIso;
      evUpdate.completed_by = userId;
      completedAt = nowIso;
    }
    if (completionSummary != null) {
      evUpdate.completion_summary = completionSummary || null;
    }
    if (Object.keys(evUpdate).length > 0) {
      const { error: cErr } = await supabaseAdmin.from('events').update(evUpdate).eq('id', eventId);
      if (cErr) throw new Error('event complete update: ' + cErr.message);
    }

    // ── 3) Per attendee: attendance_status + outcome ────────────────────────
    for (const a of attendeesIn) {
      const upd = { attendance_status: a.attendance_status };
      upd.outcome = (a.attendance_status === 'aanwezig' && a.outcome) ? a.outcome : null;
      const { error: aErr } = await supabaseAdmin
        .from('event_attendees')
        .update(upd)
        .eq('id', a.attendee_id)
        .eq('event_id', eventId);
      if (aErr) {
        console.error('[events-complete-core] attendee update', a.attendee_id, aErr.message);
        summary.warnings.push(`attendee ${a.attendee_id}: ${aErr.message}`);
      } else {
        summary.attendees_updated += 1;
      }
    }

    // ── 3b) Event follow-ups upsert ─────────────────────────────────────────
    // Blok B: outcome 'opvolgen' en 'twijfelt_nog' triggeren een follow-up.
    // Reason (notitie) is verplicht voor beide outcomes; server-side check
    // hier + UI-check in events-detail. No_show is een KALE status — geen
    // follow-up meer via dit pad. De no-show-opvolging in de follow-up-
    // cockpit werkt via event_attendees.status='no_show' (Opvolglijst-tab
    // via api/follow-up-opvolglijst.js), niet via event_followups.
    for (const a of attendeesIn) {
      const triggers = (a.attendance_status === 'aanwezig' && FOLLOWUP_OUTCOMES.has(a.outcome));
      if (!triggers) continue;
      if (!a.followup || typeof a.followup !== 'object') continue;

      const reasonText = a.followup.reason != null ? String(a.followup.reason).slice(0, 500) : null;
      // Reason (notitie) verplicht bij 'opvolgen' en 'twijfelt_nog'.
      if (a.attendance_status === 'aanwezig' && REASON_REQUIRED_OUTCOMES.has(a.outcome)) {
        if (!reasonText || !reasonText.trim()) {
          const err = new Error(`attendee ${a.attendee_id}: notitie verplicht bij outcome '${a.outcome}'`);
          err.status = 400;
          err.code = 'REASON_REQUIRED';
          throw err;
        }
      }
      const followDate = a.followup.follow_up_date || null;
      const ownerId    = a.followup.owner_id || DEFAULT_FOLLOWUP_OWNER_ID || null;

      try {
        const { data: existing, error: selErr } = await supabaseAdmin
          .from('event_followups')
          .select('id')
          .eq('attendee_id', a.attendee_id)
          .eq('status', 'open')
          .maybeSingle();
        if (selErr) { summary.warnings.push(`followup-lookup ${a.attendee_id}: ${selErr.message}`); continue; }
        if (existing) {
          const { error: upErr } = await supabaseAdmin
            .from('event_followups')
            .update({ event_id: eventId, reason: reasonText, follow_up_date: followDate, owner_id: ownerId })
            .eq('id', existing.id);
          if (upErr) summary.warnings.push(`followup-update ${a.attendee_id}: ${upErr.message}`);
          else summary.followups_updated += 1;
        } else {
          const { error: insErr } = await supabaseAdmin
            .from('event_followups')
            .insert({
              attendee_id: a.attendee_id, event_id: eventId, reason: reasonText,
              follow_up_date: followDate, owner_id: ownerId, status: 'open', created_by: userId,
            });
          if (insErr) {
            if (insErr.code === '23505') {
              const { data: again } = await supabaseAdmin
                .from('event_followups').select('id')
                .eq('attendee_id', a.attendee_id).eq('status', 'open').maybeSingle();
              if (again) {
                const { error: upErr2 } = await supabaseAdmin
                  .from('event_followups')
                  .update({ event_id: eventId, reason: reasonText, follow_up_date: followDate, owner_id: ownerId })
                  .eq('id', again.id);
                if (upErr2) summary.warnings.push(`followup-race-update ${a.attendee_id}: ${upErr2.message}`);
                else summary.followups_updated += 1;
              }
            } else {
              summary.warnings.push(`followup-insert ${a.attendee_id}: ${insErr.message}`);
            }
          } else {
            summary.followups_created += 1;
          }
        }
      } catch (e) {
        console.error('[events-complete-core followup]', a.attendee_id, e?.message || e);
        summary.warnings.push(`followup ${a.attendee_id}: ${e?.message || 'unknown'}`);
      }
    }

    // ── 4) event_mentors.was_present ────────────────────────────────────────
    {
      const { error: resetErr } = await supabaseAdmin
        .from('event_mentors').update({ was_present: false }).eq('event_id', eventId);
      if (resetErr) summary.warnings.push('mentors reset: ' + resetErr.message);
      if (presentMentorIds.length > 0) {
        const { error: setErr, count } = await supabaseAdmin
          .from('event_mentors').update({ was_present: true }, { count: 'exact' })
          .eq('event_id', eventId).in('team_member_id', presentMentorIds);
        if (setErr) summary.warnings.push('mentors mark present: ' + setErr.message);
        else summary.mentors_marked_present = count || 0;
      }
    }

    // ── 5) Uitgaven inserten ────────────────────────────────────────────────
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
        created_by            : userId,
      }));
    let insertedExpenses = [];
    if (expenseRows.length > 0) {
      const { error: exErr, data: exData } = await supabaseAdmin
        .from('event_expenses').insert(expenseRows)
        .select('id, amount, mentor_team_member_ids');
      if (exErr) summary.warnings.push('expenses insert: ' + exErr.message);
      else { insertedExpenses = exData || []; summary.expenses_inserted = insertedExpenses.length; }
    }

    // ── 6) Aanwezige mentoren met user_id ───────────────────────────────────
    const { data: mentorsAll, error: mErr } = await supabaseAdmin
      .from('event_mentors')
      .select(`
        team_member_id, was_present,
        team_members:team_member_id ( id, user_id )
      `)
      .eq('event_id', eventId);
    if (mErr) summary.warnings.push('mentors fetch (ledger): ' + mErr.message);
    const presentMentors = (mentorsAll || [])
      .filter((m) => m.was_present === true)
      .map((m) => ({ team_member_id: m.team_member_id, user_id: m.team_members?.user_id || null }));
    const eligibleMentors = presentMentors.filter((m) => !!m.user_id);
    if (presentMentors.length > eligibleMentors.length) {
      const missing = presentMentors.length - eligibleMentors.length;
      summary.warnings.push(`${missing} aanwezige mentor(en) zonder user_id — geen ledger-entries`);
      summary.skipped.mentor_zonder_user_id = missing;
    }
    const N = eligibleMentors.length;

    // ── 7) Ledger: bonus per aanwezige verkochte attendee ───────────────────
    if (N > 0) {
      const presentSold = attendeesIn.filter((a) => a.attendance_status === 'aanwezig');
      const presentIds = presentSold.map((a) => a.attendee_id);
      let attendeeRows = [];
      if (presentIds.length > 0) {
        const { data, error } = await supabaseAdmin
          .from('event_attendees')
          .select('id, customer_id, deal_id')
          .in('id', presentIds);
        if (error) summary.warnings.push('attendees fetch (bonus): ' + error.message);
        else attendeeRows = data || [];
      }

      for (const att of attendeeRows) {
        let deal = null;
        if (att.deal_id) {
          const { data: d } = await supabaseAdmin
            .from('deals')
            .select('id, customer_id, discount_percentage, sale_type, tl_quotation_status, tl_quotation_accepted_at')
            .eq('id', att.deal_id).maybeSingle();
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

        const { data: lines } = await supabaseAdmin
          .from('deal_line_items')
          .select('quantity, unit_price, vat_percentage, price_includes_vat')
          .eq('deal_id', deal.id);
        const totals = computeDealTotals(deal, lines || []);
        const basis = basisInclBtw ? totals.incl : totals.excl;
        if (!Number.isFinite(basis) || basis <= 0) { bump('deal_zonder_waarde'); continue; }

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
              console.error('[events-complete-core] bonus insert', insErr.message);
              summary.warnings.push('bonus insert: ' + insErr.message);
            }
          } else {
            summary.bonus_entries_created += 1;
            summary.total_bonus_amount = round2(summary.total_bonus_amount + perMentor);
          }
        }
      }

      // ── 8) Ledger: uitgaven splitsen ──────────────────────────────────────
      const releasedAt = new Date().toISOString();
      for (const exp of insertedExpenses) {
        const explicitIds = Array.isArray(exp.mentor_team_member_ids) ? exp.mentor_team_member_ids : null;
        const targetMentors = (explicitIds && explicitIds.length > 0)
          ? eligibleMentors.filter((m) => explicitIds.includes(m.team_member_id))
          : eligibleMentors;
        if (targetMentors.length === 0) { bump('uitgave_zonder_mentor'); continue; }
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
              console.error('[events-complete-core] uitgave insert', insErr.message);
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

    // ── Notify aanwezige mentoren (fail-soft) ───────────────────────────────
    try {
      let eventTitle = null;
      try {
        const { data: evTitle } = await supabaseAdmin
          .from('events').select('title').eq('id', eventId).maybeSingle();
        eventTitle = evTitle?.title || null;
      } catch (_) { /* fail-soft */ }
      const recipients = new Set();
      for (const m of eligibleMentors) { if (m.user_id) recipients.add(m.user_id); }
      recipients.delete(userId);
      for (const uid of recipients) {
        createNotification({
          toUserId:   uid,
          type:       'event.completed',
          title:      'Event afgerond · ' + (eventTitle || 'zonder titel'),
          body:       'Bonussen berekend',
          linkUrl:    '/modules/events-detail.html?id=' + eventId,
          entityType: 'event',
          entityId:   eventId,
          createdBy:  userId,
        }).catch(() => {});
      }
    } catch (_) { /* fail-soft */ }

    return { statusCode: 200, response: { ok: true, event_id: eventId, completed_at: completedAt, summary } };
  } catch (e) {
    console.error('[events-complete-core] fatal:', e?.message || e);
    return { statusCode: 500, response: { error: e?.message || 'Interne fout', summary } };
  }
}
