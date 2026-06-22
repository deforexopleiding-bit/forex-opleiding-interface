// api/mentor-future-students-self.js
//
// SELF — onboardings die aan de ingelogde mentor zijn toegewezen en nog
// niet gearchiveerd. Voedt de "Toekomstige studenten"-tab in het mentor-
// dashboard.
//
// Permission: mentor.module.access.
//
// Response 200:
//   { ok:true, students:[ {
//       onboarding_id, customer_name, traject_label,
//       status, current_step, paid,
//       started_at, completed_at
//   } ] }  // sort: created_at desc

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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
    const { data: rows, error: rowErr } = await supabaseAdmin
      .from('onboardings')
      .select(`id, customer_id, customer_name, status, current_step,
               started_at, completed_at, created_at,
               traject:onboarding_trajecten(label)`)
      .eq('mentor_user_id', user.id)
      .neq('status', 'gearchiveerd')
      .order('created_at', { ascending: false })
      .limit(500);
    if (rowErr) throw new Error('onboardings fetch: ' + rowErr.message);
    const list = rows || [];

    // Paid-vlag per unieke customer_id — zelfde pattern als onboardings-admin-list.
    const customerIds = Array.from(new Set(list.map((r) => r.customer_id).filter(Boolean)));
    const paidSet = new Set();
    if (customerIds.length > 0) {
      const { data: invs, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('customer_id')
        .in('customer_id', customerIds)
        .eq('status', 'paid')
        .limit(5000);
      if (invErr) throw new Error('invoices fetch: ' + invErr.message);
      for (const r of (invs || [])) {
        if (r.customer_id) paidSet.add(r.customer_id);
      }
    }

    const students = list.map((r) => ({
      onboarding_id : r.id,
      customer_name : r.customer_name || null,
      traject_label : r.traject?.label || null,
      status        : r.status,
      current_step  : r.current_step || null,
      paid          : paidSet.has(r.customer_id),
      started_at    : r.started_at,
      completed_at  : r.completed_at,
    }));

    return res.status(200).json({ ok: true, students });
  } catch (e) {
    console.error('[mentor-future-students-self]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
