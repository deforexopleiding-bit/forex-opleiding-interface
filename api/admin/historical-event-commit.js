// api/admin/historical-event-commit.js
//
// POST — Historisch event definitief boeken (SUPER_ADMIN). Roept de bestaande
// events-complete-motor aan (api/_lib/events-complete-core.js) voor bonus +
// uitgave ledger-entries. NA succesvolle bonus-aanmaak: past de "1e factuur
// betaald"-regel toe door per gekoppelde deal, per betaalde factuur, per
// payment `releaseProportionalForPayment` aan te roepen. Fail-soft per deal.
//
// GEEN tweede bonus-implementatie — motor is 1x geëxtraheerd.
//
// Body: { event_id: uuid, completion_summary?: string }
// Response 200: { ok, event_id, completed_at, summary, release: { deals: [...] } }
//
// Beveiliging: verifyAdmin + super_admin gate.

import { verifyAdmin, supabaseAdmin } from '../supabase.js';
import { runEventsCompleteCore } from '../_lib/events-complete-core.js';
import { releaseProportionalForPayment } from '../_lib/mentor-ledger-engine.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : '';
  if (!eventId || !UUID_RE.test(eventId)) return res.status(400).json({ error: 'event_id (uuid) vereist' });
  const completionSummary = typeof body.completion_summary === 'string' ? body.completion_summary.slice(0, 5000) : null;

  try {
    // ── 1. Read event + attendees + mentors + expenses uit DB ───────────────
    //    Het historische-event is opgezet via historical-event-save.js met:
    //      - event_attendees status='aanwezig'
    //      - event_mentors was_present=true
    //      - event_expenses met mentor_team_member_ids per rij
    //    We bouwen op basis hiervan de core-body op.
    const { data: attRows, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, status')
      .eq('event_id', eventId);
    if (attErr) return res.status(500).json({ error: 'attendees fetch: ' + attErr.message });

    const attendees = (attRows || []).map((a) => ({
      attendee_id      : a.id,
      attendance_status: a.status === 'aanwezig' ? 'aanwezig'
                        : a.status === 'no_show' ? 'no_show' : 'afgemeld',
    }));

    const { data: mentorRows, error: mErr } = await supabaseAdmin
      .from('event_mentors')
      .select('team_member_id, was_present')
      .eq('event_id', eventId)
      .eq('was_present', true);
    if (mErr) return res.status(500).json({ error: 'mentors fetch: ' + mErr.message });
    const presentMentorIds = (mentorRows || []).map((m) => m.team_member_id);

    // ── 2. Roep events-complete motor aan ───────────────────────────────────
    //    LET OP: expenses zijn al gepersist door historical-event-save.js. Als
    //    we ze hier opnieuw meegeven, worden ze DUBBEL geïnserteerd (motor
    //    kent geen dedup op event_expenses). Dus expenses=[] meegeven; de
    //    motor pakt bij ledger-aanmaak alleen de EXPENSES die zij zelf in
    //    stap 5 heeft geïnserteerd — dat betekent dat uitgave-ledger-entries
    //    hier NIET vanuit de motor gemaakt worden. Ze zullen wel gemaakt
    //    worden door de aparte historisch-uitgave-loop hieronder.
    const coreBody = {
      event_id             : eventId,
      attendees            : attendees,
      present_team_member_ids: presentMentorIds,
      expenses             : [], // reeds gepersist; ledger-uitgave hieronder afzonderlijk
      basis_incl_btw       : true,
      completion_summary   : completionSummary,
    };
    const coreResult = await runEventsCompleteCore({ userId: admin.user.id, body: coreBody });
    if (coreResult.statusCode !== 200) {
      return res.status(coreResult.statusCode).json(coreResult.response);
    }
    const coreSummary = coreResult.response.summary;

    // ── 3. Uitgave-ledger vanuit reeds-gepersiste event_expenses ───────────
    //    De motor slaat uitgave-ledger over omdat we haar geen fresh-insert
    //    expenses hebben gegeven. Hier repliceren we de sectie 8-logic uit
    //    events-complete-core.js met de bestaande event_expenses-rows.
    const { data: expsRaw, error: exErr } = await supabaseAdmin
      .from('event_expenses')
      .select('id, amount, mentor_team_member_ids')
      .eq('event_id', eventId);
    if (exErr) coreSummary.warnings.push('expenses fetch (post-core): ' + exErr.message);

    const { data: mentorsFull } = await supabaseAdmin
      .from('event_mentors')
      .select(`
        team_member_id, was_present,
        team_members:team_member_id ( id, user_id )
      `)
      .eq('event_id', eventId);
    const eligibleMentors = (mentorsFull || [])
      .filter((m) => m.was_present === true)
      .map((m) => ({ team_member_id: m.team_member_id, user_id: m.team_members?.user_id || null }))
      .filter((m) => !!m.user_id);

    if (eligibleMentors.length > 0 && (expsRaw || []).length > 0) {
      const releasedAt = new Date().toISOString();
      for (const exp of expsRaw) {
        const explicitIds = Array.isArray(exp.mentor_team_member_ids) ? exp.mentor_team_member_ids : null;
        const targetMentors = (explicitIds && explicitIds.length > 0)
          ? eligibleMentors.filter((m) => explicitIds.includes(m.team_member_id))
          : eligibleMentors;
        if (targetMentors.length === 0) continue;
        const amountAbs = Number(exp.amount) || 0;
        const perMentor = -Math.round((amountAbs / targetMentors.length) * 100) / 100;
        if (perMentor === 0) continue;
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
              coreSummary.skipped = coreSummary.skipped || {};
              coreSummary.skipped.uitgave_al_aangemaakt = (coreSummary.skipped.uitgave_al_aangemaakt || 0) + 1;
            } else {
              coreSummary.warnings.push('uitgave insert (post-core): ' + insErr.message);
            }
          } else {
            coreSummary.expense_entries_created = (coreSummary.expense_entries_created || 0) + 1;
            coreSummary.total_expense_amount = Math.round((coreSummary.total_expense_amount + Math.abs(perMentor)) * 100) / 100;
          }
        }
      }
    }

    // ── 4. "1e factuur betaald"-regel: releaseProportionalForPayment ────────
    //    Per aanwezige attendee met deal + customer: alle betaalde facturen
    //    ophalen, per factuur alle payments ophalen, per payment de
    //    proportionele slice vrijgeven. Fail-soft per deal — één deal-error
    //    blokkeert de overige niet.
    const releaseReport = [];
    const { data: attendeesFull } = await supabaseAdmin
      .from('event_attendees')
      .select('id, customer_id, deal_id, status')
      .eq('event_id', eventId)
      .eq('status', 'aanwezig');

    for (const a of (attendeesFull || [])) {
      if (!a.customer_id) continue;
      try {
        // Zoek betaalde facturen. Primair filter op deal_id (nieuwer schema);
        // fallback op customer_id als deal_id op de invoice NULL is.
        let invoicesQuery = supabaseAdmin
          .from('invoices')
          .select('id, deal_id, customer_id, status, amount_total, amount_paid')
          .eq('customer_id', a.customer_id)
          .eq('status', 'paid');
        if (a.deal_id) invoicesQuery = invoicesQuery.eq('deal_id', a.deal_id);
        const { data: invs, error: invErr } = await invoicesQuery;
        if (invErr) {
          releaseReport.push({ attendee_id: a.id, deal_id: a.deal_id, ok: false, error: invErr.message });
          continue;
        }
        if (!invs || invs.length === 0) {
          releaseReport.push({ attendee_id: a.id, deal_id: a.deal_id, ok: true, paid_invoices: 0, released: 0 });
          continue;
        }

        let totalReleased = 0;
        for (const inv of invs) {
          const invTotal = Number(inv.amount_total) || 0;
          if (invTotal <= 0) continue;
          const { data: pays, error: payErr } = await supabaseAdmin
            .from('payments')
            .select('id, amount, payment_date')
            .eq('invoice_id', inv.id)
            .order('payment_date', { ascending: true });
          if (payErr) {
            releaseReport.push({ attendee_id: a.id, deal_id: a.deal_id, invoice_id: inv.id, ok: false, error: payErr.message });
            continue;
          }
          const payments = pays || [];
          // fullyPaid: laatste payment triggert settle-childs voor evt. rest.
          for (let i = 0; i < payments.length; i++) {
            const p = payments[i];
            const isLast   = i === payments.length - 1;
            const payAmt   = Number(p.amount) || 0;
            if (payAmt <= 0) continue;
            try {
              const r = await releaseProportionalForPayment({
                customerId     : a.customer_id,
                sourceInvoiceId: inv.id,
                paymentId      : p.id,
                paymentAmount  : payAmt,
                invoiceTotal   : invTotal,
                fullyPaid      : isLast, // status='paid' → laatste is final
              });
              totalReleased += Number(r?.released || 0);
            } catch (e) {
              releaseReport.push({ attendee_id: a.id, invoice_id: inv.id, payment_id: p.id, ok: false, error: e?.message || 'unknown' });
            }
          }
        }
        releaseReport.push({
          attendee_id  : a.id,
          deal_id      : a.deal_id,
          ok           : true,
          paid_invoices: invs.length,
          released     : totalReleased,
        });
      } catch (e) {
        console.error('[historical-event-commit] release-loop', a.id, e?.message || e);
        releaseReport.push({ attendee_id: a.id, deal_id: a.deal_id, ok: false, error: e?.message || 'unknown' });
      }
    }

    return res.status(200).json({
      ok           : true,
      event_id     : eventId,
      completed_at : coreResult.response.completed_at,
      summary      : coreSummary,
      release      : { deals: releaseReport },
    });
  } catch (e) {
    console.error('[admin/historical-event-commit]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
