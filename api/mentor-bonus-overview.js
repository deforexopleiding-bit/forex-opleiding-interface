// api/mentor-bonus-overview.js
//
// GET → self-scope read-only bonus-overzicht + termijn-projectie + 12-maands
// forecast voor de ingelogde mentor.
//
// Permission: mentor.module.access. Self-scope: mentor_user_id = auth.uid().
//
// Bron-of-truth:
//   - mentor_ledger_entries (entry_type='bonus', status != 'geannuleerd')
//     levert de mentor-amounts per sale.
//   - subscriptions (via deals.customer_id) levert termijnschema (per_term_incl,
//     term_count, billing_cycle, start_date).
//   - invoices.amount_paid bepaalt hoeveel termijnen reeds betaald zijn.
//
// PURE PROJECTIE — geen mutaties aan ledger, vrijgave-engine of subscriptions.
// Bij ontbrekend schema (open-ended sub, term_count NULL, geen subscription
// gevonden) wordt 1 termijn getoond met `schema='onbekend'` zodat de UI weet
// dat de raming voorlopig is.
//
// Response 200:
//   {
//     ok: true,
//     scope: 'self',
//     totals: {
//       earned_total, betaald_uit, open,
//       deze_maand, volgende_maand,
//     },
//     projection_12m: [
//       { month: 'YYYY-MM', amount }
//     ],
//     per_event: [
//       { event_id, event_title, starts_at,
//         sales: [
//           { customer_id, customer_label, sale_total_incl, mentor_share_total,
//             term_count, per_term_amount, schema_unknown,
//             termijnen: [{ index, due_date, amount, status }] }
//         ] }
//     ],
//   }
// 401/403/405 zoals andere mentor-endpoints.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Bedrag incl. BTW per termijn. Identiek aan helper in sales-subscriptions-list.js.
function inclPerTerm(sub) {
  if (!sub) return 0;
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length) {
    return lines.reduce((sum, li) => sum + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100), 0);
  }
  return (Number(sub.amount) || 0) * (1 + (Number(sub.vat_percentage) || 0) / 100);
}

// Identiek aan helper in finance-dashboard-counts.js.
function billingCycleMonths(cycle) {
  if (!cycle) return 1;
  const c = String(cycle).toLowerCase();
  if (c === 'per_month')    return 1;
  if (c === 'per_2_months') return 2;
  if (c === 'per_quarter')  return 3;
  if (c === 'per_6_months') return 6;
  if (c === 'per_year')     return 12;
  const m = c.match(/per_(\d+)_months/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// 'YYYY-MM' van een Date.
function ymKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Voeg N hele kalendermaanden toe aan een datum. JS Date.setMonth handelt
// overflow correct af (31 jan + 1 maand = 28/29 feb), wat we ook willen voor
// bv. quarterly termijnen vanaf 31 mrt.
function addMonths(d, n) {
  const out = new Date(d.getTime());
  out.setMonth(out.getMonth() + n);
  return out;
}

function customerLabel(c) {
  if (!c) return '—';
  if (c.is_company) return c.company_name || c.email || '(klant)';
  const parts = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return parts || c.company_name || c.email || '(klant)';
}

// ── Handler ──────────────────────────────────────────────────────────────────

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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  try {
    // 1) Bonus-entries van deze mentor (excl. geannuleerd).
    const { data: entries, error: entErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .select('id, mentor_user_id, event_id, entry_type, basis, amount, pct, status, attendee_id, customer_id, source_invoice_id, created_at')
      .eq('mentor_user_id', user.id)
      .eq('entry_type', 'bonus')
      .neq('status', 'geannuleerd')
      .limit(5000);
    if (entErr) throw new Error('ledger fetch: ' + entErr.message);

    const rows = entries || [];

    // Snel pad: geen bonussen.
    if (rows.length === 0) {
      const now = new Date();
      const projection_12m = [];
      for (let i = 0; i < 12; i++) {
        projection_12m.push({ month: ymKey(addMonths(now, i)), amount: 0 });
      }
      return res.status(200).json({
        ok: true,
        scope: 'self',
        totals: { earned_total: 0, betaald_uit: 0, open: 0, deze_maand: 0, volgende_maand: 0 },
        projection_12m,
        per_event: [],
      });
    }

    // 2) Bijbehorende customers, deals, subscriptions, invoices.
    const eventIds    = [...new Set(rows.map((r) => r.event_id).filter(Boolean))];
    const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
    const invoiceIds  = [...new Set(rows.map((r) => r.source_invoice_id).filter(Boolean))];

    const eventById    = new Map();
    const customerById = new Map();
    const dealsByCust  = new Map(); // customer_id → [deals]
    const subByDeal    = new Map(); // deal_id → subscription (latest by start_date)
    const invoiceById  = new Map();

    if (eventIds.length) {
      const { data: evs } = await supabaseAdmin
        .from('events')
        .select('id, title, starts_at')
        .in('id', eventIds);
      for (const e of evs || []) eventById.set(e.id, e);
    }
    if (customerIds.length) {
      const { data: custs } = await supabaseAdmin
        .from('customers')
        .select('id, is_company, company_name, first_name, last_name, email')
        .in('id', customerIds);
      for (const c of custs || []) customerById.set(c.id, c);
    }
    if (customerIds.length) {
      const { data: deals } = await supabaseAdmin
        .from('deals')
        .select('id, customer_id')
        .in('customer_id', customerIds)
        .is('archived_at', null);
      for (const d of deals || []) {
        if (!dealsByCust.has(d.customer_id)) dealsByCust.set(d.customer_id, []);
        dealsByCust.get(d.customer_id).push(d);
      }
      const dealIds = (deals || []).map((d) => d.id);
      if (dealIds.length) {
        const { data: subs } = await supabaseAdmin
          .from('subscriptions')
          .select('id, deal_id, amount, vat_percentage, term_count, start_date, billing_cycle, line_items, status')
          .in('deal_id', dealIds)
          .order('start_date', { ascending: false });
        // Latest sub per deal wint.
        for (const s of subs || []) {
          if (!subByDeal.has(s.deal_id)) subByDeal.set(s.deal_id, s);
        }
      }
    }
    if (invoiceIds.length) {
      const { data: invs } = await supabaseAdmin
        .from('invoices')
        .select('id, amount_total, amount_paid, status')
        .in('id', invoiceIds);
      for (const v of invs || []) invoiceById.set(v.id, v);
    }

    // 3) Per bonus-entry de termijnen projecteren.
    // Grouping: event_id → customer_id → projected sale.
    const now    = new Date();
    const thisYm = ymKey(now);
    const nextYm = ymKey(addMonths(now, 1));

    // monthBuckets: 12 maanden vanaf deze maand.
    const monthOrder = [];
    const monthAmount = new Map();
    for (let i = 0; i < 12; i++) {
      const k = ymKey(addMonths(now, i));
      monthOrder.push(k);
      monthAmount.set(k, 0);
    }

    const perEventMap = new Map(); // event_id → { event, salesByCust }
    let earned_total = 0;
    let betaald_uit  = 0;
    let open_total   = 0;

    for (const r of rows) {
      const mentorAmount = Number(r.amount) || 0;
      const basis        = Number(r.basis) || 0;
      earned_total += mentorAmount;
      if (r.status === 'uitbetaald') betaald_uit += mentorAmount;

      // Vind subscription via customer → deals → latest sub.
      const customerDeals = dealsByCust.get(r.customer_id) || [];
      let sub = null;
      for (const d of customerDeals) {
        const candidate = subByDeal.get(d.id);
        if (candidate && (!sub || (candidate.start_date || '') > (sub.start_date || ''))) {
          sub = candidate;
        }
      }

      // Schema bepalen. Fallback bij ontbrekend schema: 1 termijn met
      // due_date = invoice-issue OF ledger-created_at, status afgeleid van
      // ledger-status zodat de UI iets toont.
      let termCount    = sub && Number.isFinite(Number(sub.term_count)) ? Number(sub.term_count) : null;
      const perTermInc = inclPerTerm(sub);
      const cycleMo    = billingCycleMonths(sub?.billing_cycle);
      const startStr   = sub?.start_date || null;
      let startDate    = startStr ? new Date(startStr) : null;
      if (!startDate || isNaN(startDate.getTime())) startDate = new Date(r.created_at);
      const schemaUnknown = !sub || !termCount || termCount < 1 || !perTermInc;

      if (schemaUnknown) {
        termCount = 1;
      }

      // Per-termijn-bonus = mentor.amount × (per_term_incl / basis).
      // Bij ontbrekend schema valt 'ie terug op 1 termijn = mentor.amount.
      let perTermMentor;
      if (schemaUnknown || basis <= 0) {
        perTermMentor = mentorAmount;
      } else {
        perTermMentor = (mentorAmount * perTermInc) / basis;
      }

      // Aantal betaalde termijnen uit invoice.amount_paid.
      const invoice  = invoiceById.get(r.source_invoice_id) || null;
      const paidAmt  = Number(invoice?.amount_paid) || 0;
      let nbPaid;
      if (schemaUnknown || perTermInc <= 0) {
        // Fallback: gebruik ledger-status — 'uitbetaald'=1, anders 0.
        nbPaid = r.status === 'uitbetaald' ? 1 : 0;
      } else {
        nbPaid = Math.max(0, Math.min(termCount, Math.floor((paidAmt + 0.005) / perTermInc)));
      }

      // Genereer termijnen.
      const termijnen = [];
      for (let i = 0; i < termCount; i++) {
        const dueDate = addMonths(startDate, i * cycleMo);
        const isPaid  = i < nbPaid;
        const tAmount = round2(perTermMentor);
        termijnen.push({
          index   : i + 1,
          due_date: dueDate.toISOString().slice(0, 10),
          amount  : tAmount,
          status  : isPaid ? 'betaald' : 'open',
        });
        if (!isPaid) open_total += tAmount;

        // Maand-bucket (alleen binnen 12m-projectie + nog niet betaald).
        if (!isPaid) {
          const k = ymKey(dueDate);
          if (monthAmount.has(k)) {
            monthAmount.set(k, (monthAmount.get(k) || 0) + tAmount);
          }
        }
      }

      // Groeperen onder event → sale (customer_id).
      const evKey = r.event_id || 'no-event';
      if (!perEventMap.has(evKey)) {
        const ev = eventById.get(r.event_id) || null;
        perEventMap.set(evKey, {
          event_id    : r.event_id || null,
          event_title : ev?.title     || null,
          starts_at   : ev?.starts_at || null,
          _sales      : new Map(),
        });
      }
      const evNode = perEventMap.get(evKey);
      const saleKey = r.customer_id || ('att:' + (r.attendee_id || r.id));
      if (!evNode._sales.has(saleKey)) {
        const cust = customerById.get(r.customer_id) || null;
        evNode._sales.set(saleKey, {
          customer_id        : r.customer_id || null,
          customer_label     : customerLabel(cust),
          sale_total_incl    : round2(perTermInc * termCount),
          mentor_share_total : round2(mentorAmount),
          term_count         : termCount,
          per_term_amount    : round2(perTermMentor),
          schema_unknown     : schemaUnknown,
          termijnen,
        });
      } else {
        // Meerdere bonus-rijen op zelfde sale (bv. extra entry): tel mentor-aandeel
        // op en breid de termijnen-array niet uit (zelfde schema).
        const cell = evNode._sales.get(saleKey);
        cell.mentor_share_total = round2(cell.mentor_share_total + mentorAmount);
      }
    }

    // Per-event array bouwen.
    const per_event = Array.from(perEventMap.values())
      .map((n) => ({
        event_id    : n.event_id,
        event_title : n.event_title,
        starts_at   : n.starts_at,
        sales       : Array.from(n._sales.values()),
      }))
      .sort((a, b) => (b.starts_at || '').localeCompare(a.starts_at || ''));

    // 12-maands projectie array.
    const projection_12m = monthOrder.map((k) => ({ month: k, amount: round2(monthAmount.get(k) || 0) }));

    const deze_maand     = round2(monthAmount.get(thisYm) || 0);
    const volgende_maand = round2(monthAmount.get(nextYm) || 0);

    return res.status(200).json({
      ok: true,
      scope: 'self',
      totals: {
        earned_total: round2(earned_total),
        betaald_uit : round2(betaald_uit),
        open        : round2(open_total),
        deze_maand,
        volgende_maand,
      },
      projection_12m,
      per_event,
    });
  } catch (e) {
    console.error('[mentor-bonus-overview]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
