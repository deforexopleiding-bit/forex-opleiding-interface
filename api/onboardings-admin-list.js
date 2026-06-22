// api/onboardings-admin-list.js
//
// ADMIN — lijst van onboardings met traject-info, toegewezen mentor en
// paid-vlag (heeft klant ≥1 invoice met status='paid'). Sorteer nieuwste
// eerst.
//
// Permission: onboarding.admin.
//
// Query (alle optioneel):
//   ?scope=active|archived   (active = status != 'gearchiveerd' [default];
//                             archived = status='gearchiveerd')
//   ?mentor_user_id=<uuid>
//   ?traject_id=<uuid>
//   ?q=<string>              (ilike op customer_name)
//
// Response 200:
//   { ok:true, rows:[ {
//       id, customer_id, customer_name,
//       traject_id, traject_label, traject_type, calls,
//       mentor_user_id, mentor_name,
//       status, current_step, paid,
//       started_at, completed_at, assigned_at, archived_at, created_at,
//       token
//   } ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeIlike(s) {
  return String(s || '').replace(/([%_,])/g, '\\$1');
}

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
  if (!(await requirePermission(req, 'onboarding.admin'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin)' });
  }

  const scopeRaw = typeof req.query?.scope === 'string' ? req.query.scope.trim().toLowerCase() : '';
  const scope = (scopeRaw === 'archived') ? 'archived' : 'active';

  const mentorFilter = typeof req.query?.mentor_user_id === 'string' ? req.query.mentor_user_id.trim() : '';
  if (mentorFilter && !UUID_RE.test(mentorFilter)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
  }
  const trajectFilter = typeof req.query?.traject_id === 'string' ? req.query.traject_id.trim() : '';
  if (trajectFilter && !UUID_RE.test(trajectFilter)) {
    return res.status(400).json({ error: 'traject_id (uuid) ongeldig' });
  }
  const qRaw = typeof req.query?.q === 'string' ? req.query.q.trim() : '';

  try {
    let q = supabaseAdmin
      .from('onboardings')
      .select(`id, customer_id, customer_name, traject_id, mentor_user_id,
               status, current_step, started_at, completed_at, assigned_at,
               archived_at, created_at, token,
               traject:onboarding_trajecten(label, type, calls)`)
      .order('created_at', { ascending: false })
      .limit(1000);
    if (scope === 'archived') q = q.eq('status', 'gearchiveerd');
    else                       q = q.neq('status', 'gearchiveerd');
    if (mentorFilter)  q = q.eq('mentor_user_id', mentorFilter);
    if (trajectFilter) q = q.eq('traject_id',     trajectFilter);
    if (qRaw)          q = q.ilike('customer_name', `%${escapeIlike(qRaw)}%`);

    const { data: rows, error: rowErr } = await q;
    if (rowErr) throw new Error('onboardings fetch: ' + rowErr.message);
    const list = rows || [];

    // Mentor-naam ophalen per uniek mentor_user_id — zelfde pattern als
    // assessments-admin-list / funded-certs-admin-list.
    const mentorIds = Array.from(new Set(list.map((r) => r.mentor_user_id).filter(Boolean)));
    const nameMap = new Map();
    if (mentorIds.length > 0) {
      const { data: tmRows, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, name')
        .in('user_id', mentorIds);
      if (tmErr) throw new Error('team_members fetch: ' + tmErr.message);
      for (const r of (tmRows || [])) {
        if (r.user_id && r.name) nameMap.set(r.user_id, r.name);
      }
    }

    // Paid-vlag per uniek customer_id: bestaat er ≥1 invoice met status='paid'?
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

    const out = list.map((r) => {
      const t = r.traject || null;
      return {
        id             : r.id,
        customer_id    : r.customer_id,
        customer_name  : r.customer_name || null,
        traject_id     : r.traject_id,
        traject_label  : t?.label || null,
        traject_type   : t?.type  || null,
        calls          : t?.calls || null,
        mentor_user_id : r.mentor_user_id || null,
        mentor_name    : r.mentor_user_id ? (nameMap.get(r.mentor_user_id) || null) : null,
        status         : r.status,
        current_step   : r.current_step || null,
        paid           : paidSet.has(r.customer_id),
        started_at     : r.started_at,
        completed_at   : r.completed_at,
        assigned_at    : r.assigned_at,
        archived_at    : r.archived_at,
        created_at     : r.created_at,
        token          : r.token,
      };
    });

    return res.status(200).json({ ok: true, rows: out });
  } catch (e) {
    console.error('[onboardings-admin-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
