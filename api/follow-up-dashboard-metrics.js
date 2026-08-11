// api/follow-up-dashboard-metrics.js
//
// GET endpoint voor KPI-cards op follow-up dashboard.
// Query: ?period=today|week|month
// Alleen toegankelijk voor super_admin, admin, manager.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { computeMetrics } from './follow-up-metrics.js';
import { requirePermission } from './_lib/requirePermission.js';

const ALLOWED_ROLES = ['super_admin', 'admin', 'manager', 'sales'];
const ALLOWED_PERIODS = ['today', 'week', 'month'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  // Additief (zie #1265): rol ∈ ALLOWED_ROLES ÓF per-user RBAC-grant
  // followup.module.access (honoreert user_permissions via de RPC). Zo werkt
  // een per-persoon-uitzondering (bv. mentor met expliciete follow-up-toegang)
  // zonder de rol te wijzigen.
  const canFollowupManage = (profile && !ALLOWED_ROLES.includes(profile.role))
    ? await requirePermission(req, 'followup.module.access') : false;
  if (!profile || (!ALLOWED_ROLES.includes(profile.role) && !canFollowupManage)) {
    return res.status(403).json({ error: 'Geen toegang tot metrics.' });
  }

  const period = String(req.query.period || 'today');
  if (!ALLOWED_PERIODS.includes(period)) {
    return res.status(400).json({ error: `period moet één van: ${ALLOWED_PERIODS.join(', ')}` });
  }

  // Sales ziet alleen eigen data; andere rollen zien alles
  const ownerScope = profile.role === 'sales' ? user.id : null;

  try {
    const metrics = await computeMetrics(supabaseAdmin, { period, ownerScope });
    return res.status(200).json({ metrics });
  } catch (err) {
    console.error('[dashboard-metrics] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
