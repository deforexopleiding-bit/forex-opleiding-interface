// api/sales-signed-deals-total.js
// GET → totaal aanvaarde offertes (TL-fase "07. Aanvaard"), gefilterd op
// tl_quotation_accepted_at binnen periode. Sommeert INCL BTW per line-item.
//
// Query-params:
//   period       'today' | 'week' | 'month' | 'year' | 'all' (default 'month')
//                Week   = maandag t/m zondag (NL)
//                Month  = 1e t/m laatste dag van huidige maand
//                Year   = 1 jan t/m 31 dec huidig kalenderjaar
//   from,to      YYYY-MM-DD (inclusive both). Overschrijft period bij aanwezig.
//                Voor Custom-picker.
//   group_by     'month' (optioneel) → returnt trend[] per maand voor de
//                gekozen periode; standaard: alleen totaal.
//
// Response:
//   {
//     total_incl_vat: number,
//     count: number,
//     period, since, until,
//     test_excluded: number,
//     trend?: [{ period: 'YYYY-MM', total_incl_vat, count }]
//   }
//
// Permission: sales.view (fallback: dashboard.view).
// Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { fetchTestDealIds } from './_lib/test-data-filter.js';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mondayOfWeek(d) {
  const day = d.getDay(); // 0=zo, 1=ma, ..., 6=za
  const diff = day === 0 ? -6 : (1 - day);
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}
function startOfMonth(d)  { return new Date(d.getFullYear(), d.getMonth(),     1); }
function startOfNextMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }
function startOfYear(d)   { return new Date(d.getFullYear(), 0, 1); }
function startOfNextYear(d) { return new Date(d.getFullYear() + 1, 0, 1); }
function endOfWeek(monday) { const e = new Date(monday); e.setDate(monday.getDate() + 7); return e; }
function endOfDay(d)      { const e = new Date(d); e.setHours(0, 0, 0, 0); e.setDate(e.getDate() + 1); return e; }

// [sinceISO, untilISO) semantiek — half-open interval [start, end).
function rangeForPeriod(p) {
  const now = new Date();
  if (p === 'today') { const s = new Date(now); s.setHours(0,0,0,0); return [isoDate(s), isoDate(endOfDay(s))]; }
  if (p === 'week')  { const s = mondayOfWeek(now); return [isoDate(s), isoDate(endOfWeek(s))]; }
  if (p === 'month') { return [isoDate(startOfMonth(now)), isoDate(startOfNextMonth(now))]; }
  if (p === 'year')  { return [isoDate(startOfYear(now)),  isoDate(startOfNextYear(now))]; }
  return [null, null];
}

function lineInclVat(li) {
  const qty = Number(li.quantity) || 0;
  const up  = Number(li.unit_price) || 0;
  const vat = Number(li.vat_percentage) || 0;
  const sub = up * qty;
  return li.price_includes_vat ? sub : sub * (1 + vat / 100);
}

function ymKey(iso) { return String(iso).slice(0, 7); } // 'YYYY-MM'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = (await requirePermission(req, 'sales.view'))
    || (await requirePermission(req, 'dashboard.view'));
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  try {
    const q = req.query || {};
    const from = q.from ? String(q.from).slice(0, 10) : null;
    const to   = q.to   ? String(q.to).slice(0, 10)   : null;
    const periodRaw = String(q.period || 'month').toLowerCase();
    const period = ['today', 'week', 'month', 'year', 'all'].includes(periodRaw) ? periodRaw : 'month';
    const groupByMonth = String(q.group_by || '').toLowerCase() === 'month';

    // Custom range OF period-preset. Custom = inclusive to → daarom +1 dag
    // om als half-open [since, until) te matchen.
    let since, until;
    if (from && to) {
      since = from;
      const toDate = new Date(to + 'T00:00:00');
      toDate.setDate(toDate.getDate() + 1);
      until = isoDate(toDate);
    } else {
      [since, until] = rangeForPeriod(period);
    }

    // Stap 1: aanvaarde deals — status='accepted' (TL-fase "07. Aanvaard").
    // Datum-filter: eerst proberen accepted_at, val terug op signed_at/created_at
    // want TL-sync gap kan accepted_at leeg laten voor recent aanvaarde deals.
    // Filter in JS zodat COALESCE-logic zuiver werkt zonder PostgREST-quirks.
    let qy = supabaseAdmin
      .from('deals')
      .select('id, tl_quotation_status, tl_quotation_accepted_at, tl_quotation_signed_at, created_at')
      .eq('tl_quotation_status', 'accepted')
      .limit(20000);
    const { data: dealsRaw, error: dErr } = await qy;
    if (dErr) throw new Error('deals: ' + dErr.message);
    const effectiveAcceptedAt = (d) => d.tl_quotation_accepted_at || d.tl_quotation_signed_at || d.created_at || null;
    const inRange = (iso) => {
      if (!iso) return false;
      const d = String(iso).slice(0, 10);
      if (since && d < since) return false;
      if (until && d >= until) return false;
      return true;
    };
    const deals = (dealsRaw || []).filter(d => inRange(effectiveAcceptedAt(d)));

    // Test-deals uitsluiten (customer.is_test=true → deal-ids).
    const testDealIds = await fetchTestDealIds(supabaseAdmin);
    const clean = deals.filter(d => !testDealIds.has(d.id));
    const testExcluded = deals.length - clean.length;
    // Ronde-20 diagnose: log altijd de flow-counts zodat we kunnen bewijzen
    // dat een tegel-nul-uitkomst uit lege data komt en niet uit over-filtering.
    console.log('[sales-signed-deals-total]', {
      period, since, until, group_by: groupByMonth ? 'month' : 'none',
      raw_deals_from_db: (dealsRaw || []).length,
      after_date_range:  deals.length,
      test_customer_deal_ids: testDealIds.size,
      test_excluded_from_range: testExcluded,
      final_deal_count: clean.length,
    });

    const ids = clean.map(d => d.id);
    if (!ids.length) {
      return res.status(200).json({
        total_incl_vat: 0, count: 0, period, since, until, test_excluded: testExcluded,
        ...(groupByMonth ? { trend: [] } : {}),
      });
    }

    // Stap 2: line-items voor deze deals → som incl BTW.
    const { data: lines, error: lErr } = await supabaseAdmin
      .from('deal_line_items')
      .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat')
      .in('deal_id', ids);
    if (lErr) throw new Error('deal_line_items: ' + lErr.message);

    // Aggreate incl-BTW per deal, dan totaal + optionele trend.
    const perDeal = new Map();
    for (const li of (lines || [])) {
      perDeal.set(li.deal_id, (perDeal.get(li.deal_id) || 0) + lineInclVat(li));
    }
    let total = 0;
    for (const v of perDeal.values()) total += v;
    total = Math.round(total * 100) / 100;

    let trend;
    if (groupByMonth) {
      // Trend: één bucket per YYYY-MM binnen [since, until).
      const buckets = new Map();
      // Voor-init lege buckets zodat lege maanden ook een punt hebben.
      if (since && until) {
        let cur = new Date(since + 'T00:00:00');
        const stop = new Date(until + 'T00:00:00');
        while (cur < stop) {
          buckets.set(ymKey(isoDate(cur)), { period: ymKey(isoDate(cur)), total_incl_vat: 0, count: 0 });
          cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
        }
      }
      for (const d of clean) {
        const key = ymKey(effectiveAcceptedAt(d));
        if (!buckets.has(key)) buckets.set(key, { period: key, total_incl_vat: 0, count: 0 });
        const b = buckets.get(key);
        b.total_incl_vat += perDeal.get(d.id) || 0;
        b.count += 1;
      }
      trend = Array.from(buckets.values())
        .sort((a, b) => a.period.localeCompare(b.period))
        .map(b => ({ ...b, total_incl_vat: Math.round(b.total_incl_vat * 100) / 100 }));
    }

    return res.status(200).json({
      total_incl_vat: total,
      count: ids.length,
      period, since, until,
      test_excluded: testExcluded,
      ...(trend ? { trend } : {}),
    });
  } catch (e) {
    console.error('[sales-signed-deals-total]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
