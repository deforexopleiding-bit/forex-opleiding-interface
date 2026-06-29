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
//       started_at, completed_at,
//       bubble_user_id, mentor_intake_status,
//       updates:[{ kind, status, note, created_at, created_by }]
//   } ] }  // sort: created_at desc

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  findAvailabilityBlock,
  buildAvailabilityView,
} from './_lib/onboarding-wizard-default.js';

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
               answers,
               started_at, completed_at, created_at, start_date,
               bubble_user_id, mentor_intake_status,
               traject:onboarding_trajecten(label)`)
      .eq('mentor_user_id', user.id)
      .neq('status', 'gearchiveerd')
      .order('created_at', { ascending: false })
      .limit(500);
    if (rowErr) throw new Error('onboardings fetch: ' + rowErr.message);
    const list = rows || [];

    // Tijdlijn per onboarding — één batched query, geen N+1. Sort ascending zodat
    // de frontend ze chronologisch kan tonen (oudst eerst) en synth-events
    // (call ingepland / call gestart) er gewoon tussengevoegd kunnen worden.
    const updatesByOnb = new Map();
    const obIds = list.map((r) => r.id).filter(Boolean);
    if (obIds.length > 0) {
      const { data: ups, error: upErr } = await supabaseAdmin
        .from('onboarding_mentor_updates')
        .select('onboarding_id, kind, status, note, created_at, created_by')
        .in('onboarding_id', obIds)
        .order('created_at', { ascending: true })
        .limit(10000);
      if (upErr) throw new Error('mentor_updates fetch: ' + upErr.message);
      for (const u of (ups || [])) {
        const key = u.onboarding_id;
        if (!key) continue;
        if (!updatesByOnb.has(key)) updatesByOnb.set(key, []);
        updatesByOnb.get(key).push({
          kind:       u.kind || null,
          status:     u.status || null,
          note:       u.note || null,
          created_at: u.created_at || null,
          created_by: u.created_by || null,
        });
      }
    }

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

    // Availability-blok 1× per request resolven uit de GEPUBLICEERDE
    // wizard-structuur. Antwoord per row wordt daarna naar label-vorm
    // gemapped door buildAvailabilityView (geen UI-formatting hier;
    // mentor-dashboard verzorgt de "Ma: Ochtend"-render).
    let availabilityBlock = null;
    try {
      const { data: wiz, error: wizErr } = await supabaseAdmin
        .from('onboarding_wizard')
        .select('published_structure')
        .eq('id', 1)
        .maybeSingle();
      if (wizErr) {
        console.warn('[mentor-future-students-self] wizard config fetch:', wizErr.message);
      } else {
        availabilityBlock = findAvailabilityBlock(wiz?.published_structure);
      }
    } catch (e) {
      console.warn('[mentor-future-students-self] wizard config exception:', e?.message || e);
    }

    const students = list.map((r) => {
      const ans = (r.answers && typeof r.answers === 'object') ? r.answers : {};
      const availability = availabilityBlock ? buildAvailabilityView(availabilityBlock, ans) : null;
      return {
        onboarding_id        : r.id,
        customer_name        : r.customer_name || null,
        traject_label        : r.traject?.label || null,
        status               : r.status,
        current_step         : r.current_step || null,
        paid                 : paidSet.has(r.customer_id),
        availability,
        started_at           : r.started_at,
        completed_at         : r.completed_at,
        start_date           : r.start_date || null,
        created_at           : r.created_at || null,
        bubble_user_id       : r.bubble_user_id || null,
        mentor_intake_status : r.mentor_intake_status || null,
        updates              : updatesByOnb.get(r.id) || [],
      };
    });

    return res.status(200).json({ ok: true, students });
  } catch (e) {
    console.error('[mentor-future-students-self]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
