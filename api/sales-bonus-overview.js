// api/sales-bonus-overview.js
// GET → per-verkoper bonus-overzicht + drill-down. super_admin-only (cross-user).
//
// Response:
//   {
//     per_sales_user: [{
//       user_id, user_name, user_email,
//       totals:  { pending:{count,sum}, earned:{count,sum}, voided:{count,sum} },
//       bonuses: [{ id, deal_id, amount, status, created_at, earned_at,
//                   customer_name, quote_reference }]
//     }],
//     grand_totals: { pending:{count,sum}, earned:{count,sum}, voided:{count,sum} }
//   }
//
// 0 incasso-writes; puur read-only op `bonuses` + join `profiles` + `deals` + `customers`.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin || admin.profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin.' });
  }

  try {
    // 1. Alle bonussen. `bonuses`-tabel blijft klein (max paar duizend).
    //    invoiced/paid mappen we voor het overzicht op 'earned' (uitbetaalstroom
    //    zit in mentor-payouts-scope; sales-verkoperbonus laat ze samen zien).
    const { data: bonuses, error: bErr } = await supabaseAdmin
      .from('bonuses')
      .select('id, deal_id, sales_user_id, amount, status, created_at, earned_at')
      .order('created_at', { ascending: false })
      .limit(5000);
    if (bErr) return res.status(500).json({ error: 'bonuses: ' + bErr.message });

    // 2. Sales-users + deals + customers voor joins.
    const salesUserIds = [...new Set((bonuses || []).map(b => b.sales_user_id).filter(Boolean))];
    const dealIds      = [...new Set((bonuses || []).map(b => b.deal_id).filter(Boolean))];

    const [{ data: users }, { data: deals }] = await Promise.all([
      salesUserIds.length
        ? supabaseAdmin.from('profiles').select('id, full_name, email').in('id', salesUserIds)
        : Promise.resolve({ data: [] }),
      dealIds.length
        ? supabaseAdmin.from('deals').select('id, customer_id, quote_reference').in('id', dealIds)
        : Promise.resolve({ data: [] }),
    ]);

    const userById = Object.create(null);
    for (const u of (users || [])) userById[u.id] = u;
    const dealById = Object.create(null);
    for (const d of (deals || [])) dealById[d.id] = d;

    const customerIds = [...new Set((deals || []).map(d => d.customer_id).filter(Boolean))];
    const { data: customers } = customerIds.length
      ? await supabaseAdmin.from('customers').select('id, first_name, last_name, company_name, is_company').in('id', customerIds)
      : { data: [] };
    const customerById = Object.create(null);
    for (const c of (customers || [])) {
      customerById[c.id] = c.is_company
        ? (c.company_name || '—')
        : ([c.first_name, c.last_name].filter(Boolean).join(' ').trim() || '—');
    }

    // 3. Normalize status buckets (map invoiced/paid → earned voor het overzicht).
    const bucketFor = (s) => {
      if (s === 'voided') return 'voided';
      if (s === 'earned' || s === 'invoiced' || s === 'paid') return 'earned';
      return 'pending';
    };

    // 4. Groepeer per sales_user_id.
    const perUserMap = Object.create(null);
    const grand = { pending: { count: 0, sum: 0 }, earned: { count: 0, sum: 0 }, voided: { count: 0, sum: 0 } };

    for (const b of (bonuses || [])) {
      const uid = b.sales_user_id || '__unassigned__';
      if (!perUserMap[uid]) {
        const u = uid !== '__unassigned__' ? userById[uid] : null;
        perUserMap[uid] = {
          user_id:    uid !== '__unassigned__' ? uid : null,
          user_name:  u ? (u.full_name || u.email || u.id) : (uid === '__unassigned__' ? '(geen sales_user_id)' : uid),
          user_email: u ? u.email : null,
          totals:     { pending: { count: 0, sum: 0 }, earned: { count: 0, sum: 0 }, voided: { count: 0, sum: 0 } },
          bonuses:    [],
        };
      }
      const row = perUserMap[uid];
      const amt = Number(b.amount) || 0;
      const bkt = bucketFor(b.status);
      row.totals[bkt].count++;
      row.totals[bkt].sum += amt;
      grand[bkt].count++;
      grand[bkt].sum += amt;

      const deal = b.deal_id ? dealById[b.deal_id] : null;
      row.bonuses.push({
        id:              b.id,
        deal_id:         b.deal_id,
        amount:          amt,
        status:          b.status,
        created_at:      b.created_at,
        earned_at:       b.earned_at,
        customer_name:   deal?.customer_id ? (customerById[deal.customer_id] || '—') : '—',
        quote_reference: deal?.quote_reference || null,
      });
    }

    // 5. Sort per verkoper op totale earned+pending sum (desc).
    const per_sales_user = Object.values(perUserMap)
      .map((r) => ({
        ...r,
        totals: {
          pending: { count: r.totals.pending.count, sum: Math.round(r.totals.pending.sum * 100) / 100 },
          earned:  { count: r.totals.earned.count,  sum: Math.round(r.totals.earned.sum  * 100) / 100 },
          voided:  { count: r.totals.voided.count,  sum: Math.round(r.totals.voided.sum  * 100) / 100 },
        },
      }))
      .sort((a, b) => (b.totals.earned.sum + b.totals.pending.sum) - (a.totals.earned.sum + a.totals.pending.sum));

    return res.status(200).json({
      per_sales_user,
      grand_totals: {
        pending: { count: grand.pending.count, sum: Math.round(grand.pending.sum * 100) / 100 },
        earned:  { count: grand.earned.count,  sum: Math.round(grand.earned.sum  * 100) / 100 },
        voided:  { count: grand.voided.count,  sum: Math.round(grand.voided.sum  * 100) / 100 },
      },
      total_bonuses: (bonuses || []).length,
    });
  } catch (e) {
    console.error('[sales-bonus-overview]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
