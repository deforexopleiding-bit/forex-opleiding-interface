// api/admin-generate-link.js
//
// Diagnose-endpoint: genereert een recovery-link voor een bestaande
// user via Supabase Admin API ZONDER mail te versturen. Bedoeld voor
// troubleshooting van de welkomst-mail / recovery-flow.
//
// POST /api/admin-generate-link
// Body: { email: string }
// Response: { action_link: string }
//
// Auth: Bearer + ADMIN_ROLES (super_admin/admin/manager).
//
// [H-01 fix 2026-08-25] Rol-cascade + audit-log toegevoegd. Voorheen kon een
// manager een recovery-link genereren voor de super_admin → password reset →
// full account takeover. Nu:
//   - target's rol MOET strikt lager zijn dan die van de caller (super_admin
//     bypass — enige rol die alle targets mag).
//   - elke succesvolle én afgewezen mint wordt naar agent_audit_log geschreven
//     (caller, target-email, target-rol, IP, redirect, actie-uitkomst).
//   - action_link zelf komt NOOIT in de audit-payload (secret).

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { authRedirectUrlForRole } from './_lib/crm-roles.js';

// BP2 (2026-09-01): 'appointmentsetter' toegevoegd — sync met api/_lib/roles.js.
const ROLE_PRIORITY = ['super_admin', 'admin', 'manager', 'sales', 'mentor', 'administratie', 'marketing', 'appointmentsetter', 'viewer'];

function canCascadeOver(callerRole, targetRole) {
  if (callerRole === 'super_admin') return true;
  const ci = ROLE_PRIORITY.indexOf(callerRole);
  const ti = ROLE_PRIORITY.indexOf(targetRole);
  if (ci < 0 || ti < 0) return false;
  return ci < ti;
}

async function auditMint({ action, payload, status = 'success', error_message = null, triggered_by }) {
  try {
    await supabaseAdmin.from('agent_audit_log').insert({
      agent_name:    'admin',
      action,
      payload,
      result:        {},
      status,
      error_message,
      triggered_by,
    });
  } catch (e) {
    console.warn('[admin-generate-link] audit-log insert failed:', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const auth = await verifyAdmin(req);
  if (!auth) {
    return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is verplicht.' });
  }

  try {
    // Target-profile ophalen VOOR de mint: nodig voor rol-cascade én audit.
    const normEmail = String(email).trim().toLowerCase();
    const { data: targetProfile, error: tpErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, email, is_active')
      .eq('email', normEmail)
      .maybeSingle();
    if (tpErr) return res.status(500).json({ error: 'target lookup: ' + tpErr.message });
    if (!targetProfile) return res.status(404).json({ error: 'Gebruiker met dit e-mailadres niet gevonden.' });

    const targetRole = targetProfile.role || 'viewer';

    // [H-01] Cascade: caller mag alleen recovery-link minten voor strikt lagere rol.
    // Zelf-recovery altijd toegestaan (idealer: gebruik gewoon "wachtwoord vergeten"-
    // flow via login-scherm, maar dit endpoint is admin-diagnose dus we sluiten
    // deze route niet af). Super_admin mag alle targets.
    if (targetProfile.id !== auth.user.id && !canCascadeOver(auth.profile.role, targetRole)) {
      await auditMint({
        action: 'generate_recovery_link',
        payload: {
          target_email: normEmail, target_role: targetRole, target_id: targetProfile.id,
          admin_email: auth.profile.email, admin_role: auth.profile.role,
          ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
          blocked_reason: 'role_cascade_violation',
        },
        status: 'error',
        error_message: 'Role-cascade violation: caller role not strictly higher than target',
        triggered_by: auth.profile.email,
      });
      return res.status(403).json({
        error: `Je hebt geen rechten om een recovery-link te minten voor een gebruiker met rol '${targetRole}'.`,
      });
    }

    const redirectTo = authRedirectUrlForRole(targetRole);
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type:    'recovery',
      email:   normEmail,
      options: { redirectTo },
    });
    if (error) {
      await auditMint({
        action: 'generate_recovery_link',
        payload: {
          target_email: normEmail, target_role: targetRole, target_id: targetProfile.id,
          admin_email: auth.profile.email, admin_role: auth.profile.role,
        },
        status: 'error',
        error_message: error.message,
        triggered_by: auth.profile.email,
      });
      return res.status(500).json({ error: `generateLink fout: ${error.message}` });
    }

    const actionLink = data?.properties?.action_link;
    if (!actionLink) {
      return res.status(500).json({ error: 'generateLink retourneerde geen action_link.' });
    }

    // [L-02 fix] Audit succes: action_link zelf NIET in payload (secret).
    await auditMint({
      action: 'generate_recovery_link',
      payload: {
        target_email: normEmail, target_role: targetRole, target_id: targetProfile.id,
        admin_email: auth.profile.email, admin_role: auth.profile.role,
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
        redirect_to: redirectTo,
      },
      triggered_by: auth.profile.email,
    });

    return res.status(200).json({ action_link: actionLink });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
