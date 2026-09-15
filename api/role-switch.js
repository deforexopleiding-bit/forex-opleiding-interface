// api/role-switch.js
//
// Self-service WEERGAVE-switch: de ingelogde gebruiker kiest in welke van ZIJN
// EIGEN rollen hij nu acteert. Zet profiles.active_role. Permissies blijven de
// union over user_roles (user_has_permission ONGEWIJZIGD) — dit is puur weergave
// (CRM-landing + de rol die api/lms-whoami aan de externe LMS teruggeeft).
//
// GEEN impersonatie: je wisselt alleen je eigen actieve rol, nooit die van een
// ander. Beveiliging: target_role mag ALLEEN een rol zijn die de gebruiker echt
// in user_roles heeft (get_user_all_roles) — anders 403. Zo kan niemand zichzelf
// tot een niet-toegekende rol (bv. super_admin) "switchen".
//
// POST { target_role: <rol> | null }
//   - een rol uit de eigen user_roles → active_role = die rol
//   - null / '' / 'reset'             → active_role = NULL (default = hoogste rol)
// 200 { active_role, roles }   400 ongeldige rol   401 geen sessie   403 rol niet toegekend

import { supabase, supabaseAdmin } from './supabase.js';
import { logActivity } from './_lib/activity-logger.js';

const VALID_ROLES = [
  'super_admin', 'admin', 'manager', 'sales', 'mentor',
  'marketing', 'administratie', 'appointmentsetter', 'viewer',
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth (fail-closed) ──────────────────────────────────────────────────
  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Bearer token vereist' });
  const token = authHeader.slice(7);

  const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !user) return res.status(401).json({ error: 'Ongeldige sessie' });

  // ── Body ────────────────────────────────────────────────────────────────
  const body = req.body || {};
  const raw = body.target_role;
  // null / '' / 'reset' → terug naar default (active_role = NULL).
  const isReset = raw == null || raw === '' || raw === 'reset';
  const targetRole = isReset ? null : String(raw).trim();
  if (!isReset && !VALID_ROLES.includes(targetRole)) {
    return res.status(400).json({ error: `Ongeldige rol. Kies uit: ${VALID_ROLES.join(', ')}.` });
  }

  // ── Rollen van de user (bron van waarheid: user_roles) ────────────────────
  let roles = [];
  try {
    const { data, error } = await supabaseAdmin.rpc('get_user_all_roles', { user_uuid: user.id });
    if (error) throw error;
    roles = Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[role-switch] get_user_all_roles:', e?.message || e);
    return res.status(500).json({ error: 'Kan rollen niet ophalen' });
  }

  // ── Beveiliging: alleen switchen naar een rol die je ECHT hebt ────────────
  if (!isReset && !roles.includes(targetRole)) {
    // Bewust géén detail lekken over welke rollen bestaan.
    logActivity({ req, userId: user.id, action: 'role.switch.denied', statusCode: 403,
      detail: { target_role: targetRole } });
    return res.status(403).json({ error: 'Je hebt deze rol niet.' });
  }

  // ── active_role zetten (of resetten) ──────────────────────────────────────
  const { error: updErr } = await supabaseAdmin
    .from('profiles')
    .update({ active_role: targetRole, updated_at: new Date().toISOString() })
    .eq('id', user.id);
  if (updErr) return res.status(500).json({ error: 'Kan actieve rol niet opslaan: ' + updErr.message });

  logActivity({ req, userId: user.id, action: 'role.switch', statusCode: 200,
    detail: { active_role: targetRole } });

  return res.status(200).json({ active_role: targetRole, roles });
}
