// api/mentor-students-invoice-status.js
//
// GET → per eigen student het aantal TE LATE facturen (alleen aantallen,
// geen bedragen / factuurdetails).
//
// Permission: mentor.module.access (mentor heeft die). 403 zonder.
// Auth: createUserClient(req).auth.getUser() → user.id. 401 zonder.
//
// SCOPING — non-injectable:
//   - Eigen-klant-set komt server-side via getMentorCustomerIds(user.id),
//     die filtert op onboardings.mentor_user_id = user.id. Geen client-input
//     wordt gelezen (e-mailadressen, customer_ids, of welk filter dan ook).
//   - Fail-closed: geen user.id → 401; lege customer-set → { byEmail: {} }
//     (200, geen ongefilterde fetch).
//
// OVERDUE-DEFINITIE — identiek aan finance-invoices deriveDisplayStatus:
//   status === 'open' AND due_date < vandaag AND credited_amount < amount_total.
//   (Volledig gecrediteerde facturen worden uitgesloten zoals in de Finance-
//    module — daarom de credited < total check.)
//
// SHAPE: { byEmail: { "<lowercased-email>": <count>, ... } }
//   Alleen entries met count > 0. Lege set → { byEmail: {} }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getMentorCustomerIds } from './_lib/onboardingScope.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // 1. Auth-check.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  // 2. Permission-gate.
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  try {
    // 3. Scoping: eigen klanten via mentor_user_id-koppeling.
    const customerIds = await getMentorCustomerIds(user.id);
    if (!Array.isArray(customerIds) || customerIds.length === 0) {
      return res.status(200).json({ byEmail: {} });
    }

    // 4. Batch-fetch customer (id, email) — voor de map id → lowercased email.
    const { data: customers, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, email')
      .in('id', customerIds);
    if (cErr) throw new Error('customers fetch: ' + cErr.message);

    const idToEmail = new Map();
    for (const c of (customers || [])) {
      if (c && c.id && c.email) {
        const e = String(c.email).trim().toLowerCase();
        if (e) idToEmail.set(c.id, e);
      }
    }
    if (idToEmail.size === 0) return res.status(200).json({ byEmail: {} });

    // 5. Vandaag in YYYY-MM-DD (matcht deriveDisplayStatus's `td`-vorm).
    const today = new Date().toISOString().slice(0, 10);

    // 6. Batch-fetch invoices die kandidaat zijn voor 'overdue':
    //    server-side al filteren op status='open' + due_date < vandaag,
    //    zodat we zo min mogelijk rijen ophalen. credited-check doen we
    //    client-side (na fetch) want PostgREST kan geen kolom-tegen-kolom
    //    .lt('credited_amount', 'amount_total') in 1 call.
    const { data: invoices, error: iErr } = await supabaseAdmin
      .from('invoices')
      .select('customer_id, status, due_date, amount_total, credited_amount')
      .in('customer_id', Array.from(idToEmail.keys()))
      .eq('status', 'open')
      .lt('due_date', today);
    if (iErr) throw new Error('invoices fetch: ' + iErr.message);

    // 7. Tel per customer_id de overdue's (credited < amount_total).
    const countById = new Map();
    for (const inv of (invoices || [])) {
      const credited = Number(inv.credited_amount) || 0;
      const total    = Number(inv.amount_total)    || 0;
      // 'Niet volledig gecrediteerd' = credited < total. total<=0 wordt
      // veiligheidshalve niet als overdue behandeld (geen positief saldo
      // om te betalen).
      if (total <= 0) continue;
      if (credited >= total) continue;
      const cid = inv.customer_id;
      if (!cid) continue;
      countById.set(cid, (countById.get(cid) || 0) + 1);
    }

    // 8. Map naar { byEmail: { ... } } — alleen entries > 0.
    const byEmail = {};
    for (const [cid, count] of countById.entries()) {
      if (count <= 0) continue;
      const email = idToEmail.get(cid);
      if (!email) continue;
      byEmail[email] = (byEmail[email] || 0) + count;
    }

    return res.status(200).json({ byEmail });
  } catch (e) {
    console.error('[mentor-students-invoice-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
