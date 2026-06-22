// api/onboarding-detail.js
//
// ADMIN — volledige onboarding-detailrij inclusief vragenlijst-antwoorden
// (jsonb), traject-info, mentor-naam en paid-vlag.
//
// Permission: onboarding.admin.
//
// Query:
//   ?id=<uuid>   (verplicht)
//
// Response 200:
//   { ok:true, onboarding:{ ...alle kolommen..., traject_label, traject_type,
//                           calls, duur_maanden, mentor_name, paid } }
// 404 bij onbekend id.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { data: row, error: rowErr } = await supabaseAdmin
      .from('onboardings')
      .select(`id, customer_id, customer_name, traject_id, mentor_user_id,
               status, current_step, answers, token,
               started_at, completed_at, assigned_at, archived_at,
               created_by, created_at, updated_at,
               traject:onboarding_trajecten(label, type, calls, duur_maanden)`)
      .eq('id', id)
      .maybeSingle();
    if (rowErr) throw new Error('onboarding fetch: ' + rowErr.message);
    if (!row)  return res.status(404).json({ error: 'Onboarding niet gevonden' });

    // Mentor-naam ophalen indien toegewezen.
    let mentorName = null;
    if (row.mentor_user_id) {
      const { data: tm, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('name')
        .eq('user_id', row.mentor_user_id)
        .maybeSingle();
      if (tmErr) throw new Error('team_member fetch: ' + tmErr.message);
      mentorName = tm?.name || null;
    }

    // Paid-vlag: heeft de klant ≥1 invoice met status='paid'.
    let paid = false;
    if (row.customer_id) {
      const { data: inv, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('id')
        .eq('customer_id', row.customer_id)
        .eq('status', 'paid')
        .limit(1)
        .maybeSingle();
      if (invErr) throw new Error('invoices fetch: ' + invErr.message);
      paid = !!inv;
    }

    const t = row.traject || null;
    return res.status(200).json({
      ok: true,
      onboarding: {
        id             : row.id,
        customer_id    : row.customer_id,
        customer_name  : row.customer_name || null,
        traject_id     : row.traject_id,
        traject_label  : t?.label         || null,
        traject_type   : t?.type          || null,
        calls          : t?.calls         || null,
        duur_maanden   : t?.duur_maanden  || null,
        mentor_user_id : row.mentor_user_id || null,
        mentor_name    : mentorName,
        status         : row.status,
        current_step   : row.current_step || null,
        answers        : row.answers || null,
        paid,
        token          : row.token,
        started_at     : row.started_at,
        completed_at   : row.completed_at,
        assigned_at    : row.assigned_at,
        archived_at    : row.archived_at,
        created_by     : row.created_by || null,
        created_at     : row.created_at,
        updated_at     : row.updated_at  || null,
      },
    });
  } catch (e) {
    console.error('[onboarding-detail]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
