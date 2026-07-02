// api/admin/historical-event-preview.js
//
// POST — Bonus-preview voor een historisch event (SUPER_ADMIN, READ-ONLY).
// SCHRIJFT NIETS. Berekent per aanwezige mentor, per gekoppelde deal:
//   bonus = 3% × deal.total_amount(INCL BTW) / N_aanwezige_mentoren
// en trekt het kosten-aandeel af (som(expenses) verdeeld conform de
// per-expense mentor_team_member_ids-toewijzing, of over alle mentoren als
// die array leeg is).
//
// Body: { event_id: uuid }
// Response 200: { event_id, N, mentors: [{team_member_id, name, user_id,
//                 bonus_total, expense_share_total, netto}],
//                 deals: [{deal_id, customer_name, basis_incl, per_mentor,
//                 has_paid_invoice, invoice_status_summary}],
//                 expenses: [{id, amount, mentor_team_member_ids}],
//                 totals: { bonus_total, expense_total, netto } }
//
// Beveiliging: verifyAdmin + super_admin gate. Geen inserts, geen updates.

import { verifyAdmin, supabaseAdmin } from '../supabase.js';
import { computeDealTotals } from '../_lib/deal-total.js';

const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCEPTED  = new Set(['accepted', 'signed']);
const BONUS_PCT = 3;

function round2(n) { return Math.round(Number(n) * 100) / 100; }

function customerDisplayName(c) {
  if (!c) return '(onbekend)';
  if (c.is_company && c.company_name) return c.company_name;
  const parts = [c.first_name, c.last_name].filter(Boolean);
  const name  = parts.join(' ').trim();
  return name || c.email || '(zonder naam)';
}

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

  const warnings = [];

  try {
    // ── 1. Event bestaat? ────────────────────────────────────────────────
    const { data: event, error: evErr } = await supabaseAdmin
      .from('events').select('id, title, starts_at').eq('id', eventId).maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!event) return res.status(404).json({ error: 'Event niet gevonden' });

    // ── 2. Aanwezige mentoren (was_present=true) → team_member + user_id ─
    const { data: mentorsAll, error: mErr } = await supabaseAdmin
      .from('event_mentors')
      .select(`
        team_member_id, was_present,
        team_members:team_member_id ( id, user_id, name )
      `)
      .eq('event_id', eventId);
    if (mErr) throw new Error('mentors fetch: ' + mErr.message);
    const presentMentors = (mentorsAll || [])
      .filter((m) => m.was_present === true)
      .map((m) => ({
        team_member_id: m.team_member_id,
        user_id       : m.team_members?.user_id || null,
        name          : m.team_members?.name || '(zonder naam)',
      }));
    const eligibleMentors = presentMentors.filter((m) => !!m.user_id);
    if (presentMentors.length > eligibleMentors.length) {
      warnings.push(`${presentMentors.length - eligibleMentors.length} aanwezige mentor(en) zonder user_id — géén ledger-entries bij commit`);
    }
    const N = eligibleMentors.length;

    // ── 3. Aanwezige attendees + deals ───────────────────────────────────
    const { data: attRows, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, customer_id, deal_id, status')
      .eq('event_id', eventId)
      .eq('status', 'aanwezig');
    if (attErr) throw new Error('attendees fetch: ' + attErr.message);
    const attendees = attRows || [];

    // Verzamel deal-ids + fallback via customer_id.
    const dealIdsDirect = attendees.map((a) => a.deal_id).filter(Boolean);
    const custIdsFallback = attendees.filter((a) => !a.deal_id && a.customer_id).map((a) => a.customer_id);

    // Fetch direct-linked deals.
    const dealMap = new Map(); // deal_id → deal-row
    if (dealIdsDirect.length) {
      const { data: ds } = await supabaseAdmin
        .from('deals')
        .select('id, customer_id, discount_percentage, sale_type, tl_quotation_status, tl_quotation_accepted_at')
        .in('id', dealIdsDirect);
      for (const d of (ds || [])) dealMap.set(d.id, d);
    }
    // Fetch fallback deals per customer (nieuwste accepted/signed).
    const custDealMap = new Map(); // customer_id → deal-row
    if (custIdsFallback.length) {
      const { data: ds2 } = await supabaseAdmin
        .from('deals')
        .select('id, customer_id, discount_percentage, sale_type, tl_quotation_status, tl_quotation_accepted_at')
        .in('customer_id', custIdsFallback)
        .in('tl_quotation_status', ['accepted', 'signed'])
        .order('tl_quotation_accepted_at', { ascending: false, nullsFirst: false });
      for (const d of (ds2 || [])) {
        if (!custDealMap.has(d.customer_id)) custDealMap.set(d.customer_id, d);
      }
    }

    // Verzamel line-items in één batch.
    const allDealIds = new Set();
    for (const a of attendees) {
      const d = a.deal_id ? dealMap.get(a.deal_id) : custDealMap.get(a.customer_id);
      if (d && (ACCEPTED.has(String(d.tl_quotation_status || '').toLowerCase()) || d.tl_quotation_accepted_at)) {
        allDealIds.add(d.id);
      }
    }
    const linesMap = new Map(); // deal_id → array<line>
    if (allDealIds.size) {
      const { data: lines } = await supabaseAdmin
        .from('deal_line_items')
        .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat')
        .in('deal_id', [...allDealIds]);
      for (const l of (lines || [])) {
        if (!linesMap.has(l.deal_id)) linesMap.set(l.deal_id, []);
        linesMap.get(l.deal_id).push(l);
      }
    }

    // Customer namen batch.
    const custIdsAll = new Set(attendees.map((a) => a.customer_id).filter(Boolean));
    const custNameMap = new Map();
    if (custIdsAll.size) {
      const { data: cs } = await supabaseAdmin
        .from('customers')
        .select('id, first_name, last_name, email, is_company, company_name')
        .in('id', [...custIdsAll]);
      for (const c of (cs || [])) custNameMap.set(c.id, customerDisplayName(c));
    }

    // Invoices per deal (voor paid-status). deal.id is FK; we lezen ALLE
    // invoices per deal-id én per customer_id (bij deals zonder invoice.deal_id).
    const invoiceMap = new Map(); // deal_id → array<invoice>
    if (allDealIds.size) {
      const { data: invs } = await supabaseAdmin
        .from('invoices')
        .select('id, deal_id, customer_id, status, amount_total, amount_paid, invoice_number, invoice_date')
        .in('deal_id', [...allDealIds]);
      for (const inv of (invs || [])) {
        if (!invoiceMap.has(inv.deal_id)) invoiceMap.set(inv.deal_id, []);
        invoiceMap.get(inv.deal_id).push(inv);
      }
    }

    // ── 4. Bereken per deal: basis + per-mentor + paid-status ────────────
    const dealsOut = [];
    const perMentorBonus = new Map(); // team_member_id → total bonus (EUR)
    for (const a of attendees) {
      let deal = null;
      if (a.deal_id) {
        const d = dealMap.get(a.deal_id);
        if (d && (ACCEPTED.has(String(d.tl_quotation_status || '').toLowerCase()) || d.tl_quotation_accepted_at)) {
          deal = d;
        }
      }
      if (!deal && a.customer_id) {
        const d = custDealMap.get(a.customer_id);
        if (d) deal = d;
      }
      if (!deal) {
        dealsOut.push({
          attendee_id: a.id, deal_id: null,
          customer_name: a.customer_id ? (custNameMap.get(a.customer_id) || '(onbekend)') : '(geen klant)',
          basis_incl: 0, per_mentor: 0,
          has_paid_invoice: false, invoice_status_summary: 'geen deal/offerte gekoppeld',
          skip_reason: 'attendee_zonder_getekende_offerte',
        });
        continue;
      }

      const lines  = linesMap.get(deal.id) || [];
      const totals = computeDealTotals(deal, lines);
      const basis  = totals.incl;
      const perMentor = (N > 0 && basis > 0) ? round2((BONUS_PCT * basis / 100) / N) : 0;

      // Paid-status per deal: >=1 invoice met status='paid'.
      const invs = invoiceMap.get(deal.id) || [];
      const paidInvs = invs.filter((i) => String(i.status || '').toLowerCase() === 'paid');
      const anyPaid  = paidInvs.length > 0;
      const invoiceSummary = invs.length === 0
        ? 'geen facturen'
        : `${paidInvs.length}/${invs.length} betaald`;

      dealsOut.push({
        attendee_id: a.id, deal_id: deal.id,
        customer_name: deal.customer_id ? (custNameMap.get(deal.customer_id) || custNameMap.get(a.customer_id) || '(onbekend)') : '(onbekend)',
        basis_incl: round2(basis),
        per_mentor: perMentor,
        has_paid_invoice: anyPaid,
        invoice_status_summary: invoiceSummary,
      });

      if (perMentor > 0) {
        for (const m of eligibleMentors) {
          perMentorBonus.set(m.team_member_id, round2((perMentorBonus.get(m.team_member_id) || 0) + perMentor));
        }
      }
    }

    // ── 5. Uitgaven: laad + verdeel per expense over aangewezen mentoren ─
    const { data: expsRaw, error: exErr } = await supabaseAdmin
      .from('event_expenses')
      .select('id, amount, vendor, spent_at, note, mentor_team_member_ids')
      .eq('event_id', eventId);
    if (exErr) throw new Error('expenses fetch: ' + exErr.message);
    const expenses = expsRaw || [];

    const perMentorExpense = new Map(); // team_member_id → total aandeel (EUR, POSITIVE)
    for (const exp of expenses) {
      const explicitIds = Array.isArray(exp.mentor_team_member_ids) ? exp.mentor_team_member_ids : null;
      const targetMentors = (explicitIds && explicitIds.length > 0)
        ? eligibleMentors.filter((m) => explicitIds.includes(m.team_member_id))
        : eligibleMentors;
      if (targetMentors.length === 0) continue;
      const amountAbs = Number(exp.amount) || 0;
      const perShare  = round2(amountAbs / targetMentors.length);
      for (const m of targetMentors) {
        perMentorExpense.set(m.team_member_id, round2((perMentorExpense.get(m.team_member_id) || 0) + perShare));
      }
    }

    // ── 6. Aggregeer per mentor ──────────────────────────────────────────
    const mentorsOut = presentMentors.map((m) => {
      const bonusTotal = m.user_id ? (perMentorBonus.get(m.team_member_id) || 0) : 0;
      const expShare   = m.user_id ? (perMentorExpense.get(m.team_member_id) || 0) : 0;
      return {
        team_member_id      : m.team_member_id,
        user_id             : m.user_id,
        name                : m.name,
        bonus_total         : round2(bonusTotal),
        expense_share_total : round2(expShare),
        netto               : round2(bonusTotal - expShare),
        eligible            : !!m.user_id,
      };
    });

    const totalsOut = {
      bonus_total   : round2(mentorsOut.reduce((s, m) => s + m.bonus_total, 0)),
      expense_total : round2(mentorsOut.reduce((s, m) => s + m.expense_share_total, 0)),
      netto         : round2(mentorsOut.reduce((s, m) => s + m.netto, 0)),
    };

    return res.status(200).json({
      ok        : true,
      event_id  : eventId,
      event_title: event.title,
      N,
      mentors   : mentorsOut,
      deals     : dealsOut,
      expenses  : expenses.map((e) => ({
        id: e.id, amount: Number(e.amount) || 0,
        vendor: e.vendor || null, spent_at: e.spent_at || null,
        mentor_team_member_ids: e.mentor_team_member_ids || null,
      })),
      totals    : totalsOut,
      warnings,
    });
  } catch (e) {
    console.error('[admin/historical-event-preview]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout', warnings });
  }
}
