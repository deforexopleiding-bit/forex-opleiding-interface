// api/admin/bonus-release-sync.js
//
// POST — Inhaal-release voor alle pending/gedeeltelijk-vrijgegeven
// bonus-obligaties. Loopt over alle unieke customer_ids in de parent-set
// en roept releaseProportionalForPaidInvoices per klant aan.
//
// Modus:
//   - dry_run=true  (default): berekent + rapporteert wat vrijgegeven ZOU
//     worden per mentor/klant, schrijft niets.
//   - dry_run=false: voert de release uit. Kan periodiek gedraaid worden
//     naarmate klanten meer termijnen betalen — de engine is idempotent
//     op (parent_id, allocated_paid_cents).
//
// Body: { dry_run?: boolean, customer_id?: uuid }
//   customer_id (optioneel): beperk de sync tot één klant (test/single-run).
//
// Response 200: { ok:true, dry_run, customers_scanned, per_customer:[…],
//                 totals: { total_released, released_children,
//                           parents_touched, per_mentor: [{ mentor_user_id,
//                           total_released, released_children }] } }
// Response 403: geen super_admin.
// Response 500: DB-fout.
//
// Beveiliging: verifyAdmin + super_admin gate.

import { verifyAdmin, supabaseAdmin } from '../supabase.js';
import { releaseProportionalForPaidInvoices } from '../_lib/mentor-ledger-engine.js';

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
  const dryRun = body.dry_run !== false; // default true (safety)
  const singleCust = typeof body.customer_id === 'string' && body.customer_id.trim();
  if (singleCust && !UUID_RE.test(singleCust)) {
    return res.status(400).json({ error: 'customer_id (uuid) ongeldig' });
  }

  try {
    // 1) Verzamel unieke customer_ids uit parent-obligaties (bonus, geen
    //    child, status pending/wachten_op_betaling, amount > 0).
    let uniqCustomerIds = [];
    if (singleCust) {
      uniqCustomerIds = [singleCust];
    } else {
      const { data: parents, error: pErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .select('customer_id, amount')
        .eq('entry_type', 'bonus')
        .in('status', ['pending', 'wachten_op_betaling'])
        .is('parent_entry_id', null)
        .gt('amount', 0);
      if (pErr) throw new Error('parents scan: ' + pErr.message);
      const set = new Set();
      for (const p of (parents || [])) {
        if (p.customer_id) set.add(p.customer_id);
      }
      uniqCustomerIds = [...set];
    }

    // 2) Per klant releaseProportionalForPaidInvoices aanroepen. Fail-soft:
    //    één klant-fout mag de rest niet blokkeren.
    const per_customer = [];
    let total_released    = 0;
    let released_children = 0;
    let parents_touched   = 0;
    const perMentor = new Map(); // mentor_user_id → { total_released, released_children }

    for (const cid of uniqCustomerIds) {
      try {
        const r = await releaseProportionalForPaidInvoices({ customerId: cid, dryRun });
        per_customer.push({
          customer_id      : cid,
          paid_total       : r.paid_total,
          last_paid_date   : r.last_paid_date,
          parents_touched  : r.parents_touched,
          released_children: r.released_children,
          total_released   : r.total_released,
          simulations      : (r.simulations || []).filter((s) => s.would_release),
        });
        total_released    += r.total_released;
        released_children += r.released_children;
        parents_touched   += r.parents_touched;
        for (const s of (r.simulations || [])) {
          if (!s.would_release) continue;
          const key = s.mentor_user_id;
          if (!perMentor.has(key)) perMentor.set(key, { total_released: 0, released_children: 0 });
          const acc = perMentor.get(key);
          acc.total_released    = Math.round((acc.total_released + Number(s.slice_amount)) * 100) / 100;
          acc.released_children += 1;
        }
      } catch (e) {
        console.error('[bonus-release-sync]', cid, e?.message || e);
        per_customer.push({ customer_id: cid, ok: false, error: e?.message || 'unknown' });
      }
    }

    return res.status(200).json({
      ok               : true,
      dry_run          : !!dryRun,
      customers_scanned: uniqCustomerIds.length,
      per_customer,
      totals: {
        total_released   : Math.round(total_released * 100) / 100,
        released_children,
        parents_touched,
        per_mentor       : [...perMentor.entries()].map(([mentor_user_id, v]) => ({
          mentor_user_id, ...v,
        })),
      },
    });
  } catch (e) {
    console.error('[admin/bonus-release-sync]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
