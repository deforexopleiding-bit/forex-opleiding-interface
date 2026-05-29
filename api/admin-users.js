// Admin user management endpoint
// All operations require a valid admin Bearer token.
// Writes audit entries to agent_audit_log after every mutation.

import nodemailer from 'nodemailer';
import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

const VALID_ROLES = ['super_admin', 'admin', 'manager', 'sales', 'mentor', 'marketing', 'administratie', 'viewer'];
const SITE_URL    = 'https://forex-opleiding-interface.vercel.app';

// Rol-hiërarchie (hoog → laag). Gebruikt om profiles.role (primair, voor legacy
// requireAuth) te syncen met de hoogste rol uit user_roles. Houd identiek aan
// api/admin-rbac-backfill-roles.js.
const ROLE_PRIORITY = ['super_admin', 'admin', 'manager', 'sales', 'mentor', 'administratie', 'marketing', 'viewer'];

function computeHighestRole(roles) {
  if (!roles || roles.length === 0) return 'viewer';
  for (const r of ROLE_PRIORITY) if (roles.includes(r)) return r;
  return 'viewer';
}

// ── Audit helper ──────────────────────────────────────────────────────────────

async function logAudit({ action, payload = {}, status = 'success', error_message = null, triggered_by = 'system' }) {
  try {
    const { error } = await supabaseAdmin.from('agent_audit_log').insert({
      agent_name:    'admin',
      action,
      payload,
      result:        {},
      status,
      error_message,
      triggered_by,
    });
    if (error) console.error('[admin-users] audit log insert failed:', error.message);
  } catch (e) {
    console.error('[admin-users] audit log exception:', e.message);
  }
}

// ── Mail helper ───────────────────────────────────────────────────────────────

const FROM_ADDRESS = 'info@deforexopleiding.nl';

function buildInviteMailOpts({ toEmail, fullName, role, actionLink }) {
  const displayName = fullName || toEmail;
  const rolLabel    = role.charAt(0).toUpperCase() + role.slice(1);

  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:#093d54;padding:28px 40px;text-align:center;">
          <p style="margin:0;color:#8aa5b3;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;font-weight:600;">Agency Command Center</p>
          <p style="margin:6px 0 0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">De Forex Opleiding</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:36px 40px 28px;">
          <p style="margin:0 0 16px;font-size:15px;color:#1a2333;font-weight:600;">Welkom, ${displayName}!</p>
          <p style="margin:0 0 20px;font-size:14px;color:#4a5568;line-height:1.6;">
            Je bent toegevoegd als gebruiker van het <strong>Agency Command Center</strong> van De Forex Opleiding.
            Je hebt toegang als <strong>${rolLabel}</strong>.
          </p>
          <p style="margin:0 0 28px;font-size:14px;color:#4a5568;line-height:1.6;">
            Klik op de knop hieronder om je wachtwoord aan te maken en in te loggen.
            De link is 24 uur geldig.
          </p>

          <!-- CTA button -->
          <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
            <tr><td style="background:#093d54;border-radius:8px;">
              <a href="${actionLink}"
                 style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;letter-spacing:-0.1px;">
                Maak nu je wachtwoord aan
              </a>
            </td></tr>
          </table>

          <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;">
            Werkt de knop niet? Kopieer deze link in je browser:<br/>
            <a href="${actionLink}" style="color:#688b9b;word-break:break-all;">${actionLink}</a>
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:18px 40px;border-top:1px solid #edf2f7;text-align:center;">
          <p style="margin:0;font-size:11px;color:#9ca3af;">
            Dit bericht is verstuurd door Agency Command Center &mdash; De Forex Opleiding
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Welkom bij De Forex Opleiding — Agency Command Center

Hallo ${displayName},

Je bent toegevoegd als gebruiker met de rol: ${rolLabel}.

Klik op de link hieronder om je wachtwoord aan te maken (geldig 24 uur):
${actionLink}

Met vriendelijke groet,
De Forex Opleiding`;

  return {
    from:    `"De Forex Opleiding" <${FROM_ADDRESS}>`,
    to:      toEmail,
    subject: 'Welkom bij De Forex Opleiding — stel je wachtwoord in',
    text,
    html,
  };
}

async function sendInviteMail({ toEmail, fullName, role, actionLink }) {
  const password = process.env.IMAP_PASS_INFO;
  if (!password) throw new Error('IMAP_PASS_INFO niet geconfigureerd in env vars');

  const transporter = nodemailer.createTransport({
    host:   'smtp.strato.com',
    port:   465,
    secure: true,
    auth: { user: FROM_ADDRESS, pass: password },
  });

  const mailOpts = buildInviteMailOpts({ toEmail, fullName, role, actionLink });
  await transporter.sendMail(mailOpts);
}

// ── Generate recovery link ────────────────────────────────────────────────────

async function generateRecoveryLink(email) {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type:    'recovery',
    email,
    options: { redirectTo: `${SITE_URL}/reset-password.html` },
  });
  if (error) throw new Error(`Kon recovery link niet genereren: ${error.message}`);
  const actionLink = data?.properties?.action_link;
  if (!actionLink) throw new Error('generateLink retourneerde geen action_link');
  return actionLink;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const admin = await verifyAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  }

  // ── GET — lijst alle profiles ─────────────────────────────────────────────

  if (req.method === 'GET') {
    const { data: users, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .order('role')
      .order('email');

    if (error) return res.status(500).json({ error: error.message });

    // Multi-role: voeg alle user_roles per gebruiker toe (bron van waarheid voor permissions)
    const { data: roleRows } = await supabaseAdmin.from('user_roles').select('user_id, role');
    const rolesByUser = {};
    (roleRows || []).forEach((r) => { (rolesByUser[r.user_id] ||= []).push(r.role); });
    const withRoles = (users || []).map((u) => ({
      ...u,
      all_roles: rolesByUser[u.id] || (u.role ? [u.role] : []),
    }));

    return res.status(200).json({ users: withRoles });
  }

  // ── POST — nieuwe user aanmaken ÓÓÓF resend invite ────────────────────────

  if (req.method === 'POST') {
    const { email, full_name, role, resend_only } = req.body || {};

    if (!email) return res.status(400).json({ error: 'E-mailadres is verplicht.' });

    // ── Resend invite ──────────────────────────────────────────────────────
    if (resend_only) {
      const { data: existingProfile } = await supabaseAdmin
        .from('profiles')
        .select('id, is_active, full_name, role')
        .eq('email', email)
        .single();

      if (!existingProfile) {
        return res.status(404).json({ error: 'Geen gebruiker gevonden met dit e-mailadres.' });
      }
      if (!existingProfile.is_active) {
        return res.status(400).json({ error: 'Gebruiker is gedeactiveerd. Heractiveer eerst.' });
      }

      try {
        const actionLink = await generateRecoveryLink(email);
        await sendInviteMail({
          toEmail:    email,
          fullName:   existingProfile.full_name || email,
          role:       existingProfile.role,
          actionLink,
        });

        await logAudit({
          action:       'resend_invite',
          payload:      { target_email: email, target_id: existingProfile.id, admin_email: admin.profile.email },
          status:       'success',
          triggered_by: admin.profile.email,
        });

        return res.status(200).json({ message: 'Uitnodigingsmail opnieuw verstuurd.' });
      } catch (e) {
        await logAudit({
          action:        'resend_invite',
          payload:       { target_email: email, admin_email: admin.profile.email },
          status:        'error',
          error_message: e.message,
          triggered_by:  admin.profile.email,
        });
        return res.status(500).json({ error: e.message });
      }
    }

    // ── Nieuwe user aanmaken ───────────────────────────────────────────────
    if (!role) return res.status(400).json({ error: 'Rol is verplicht.' });
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Ongeldige rol. Kies uit: ${VALID_ROLES.join(', ')}.` });
    }
    if (role === 'super_admin' && admin.profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin kan de super_admin-rol toekennen.' });
    }

    // 409 als profile al bestaat
    const { data: duplicate } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('email', email)
      .single();

    if (duplicate) {
      return res.status(409).json({ error: 'Er bestaat al een gebruiker met dit e-mailadres.' });
    }

    // Tijdelijk wachtwoord — user overschrijft via recovery link
    const crypto = await import('crypto');
    const tempPassword = crypto.randomBytes(16).toString('hex') + '!Aa1';

    const { data: createData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password:      tempPassword,
      email_confirm: true,
      user_metadata: { full_name: full_name || '', role },
    });

    if (createError) {
      await logAudit({
        action:        'create_user',
        payload:       { target_email: email, admin_email: admin.profile.email },
        status:        'error',
        error_message: createError.message,
        triggered_by:  admin.profile.email,
      });
      return res.status(400).json({ error: createError.message });
    }

    // Recovery link genereren + branded mail sturen
    let mailSent = false;
    let mailError = null;
    try {
      const actionLink = await generateRecoveryLink(email);
      await sendInviteMail({
        toEmail:    email,
        fullName:   full_name || email,
        role,
        actionLink,
      });
      mailSent = true;
    } catch (e) {
      mailError = e.message;
      console.error('[admin-users] invite mail failed:', e.message);
    }

    await logAudit({
      action:        'create_user',
      payload: {
        target_email: email,
        target_id:    createData.user.id,
        admin_email:  admin.profile.email,
        role,
        full_name:    full_name || '',
        mail_sent:    mailSent,
        ...(mailError ? { mail_error: mailError } : {}),
      },
      status:        'success',
      triggered_by:  admin.profile.email,
    });

    return res.status(201).json({
      user:      createData.user,
      mail_sent: mailSent,
      message:   mailSent
        ? 'Gebruiker aangemaakt en uitnodigingsmail verstuurd.'
        : `Gebruiker aangemaakt maar mail sturen mislukt: ${mailError}`,
    });
  }

  // ── PATCH — update role / is_active / full_name ────────────────────────────

  if (req.method === 'PATCH') {
    const userId = req.query.id;
    if (!userId) return res.status(400).json({ error: 'Query parameter ?id is verplicht.' });

    const { role, is_active, full_name, add_role, remove_role } = req.body || {};

    // ── Multi-role beheer via user_roles (alleen super_admin) ─────────────────
    if (add_role !== undefined || remove_role !== undefined) {
      if (admin.profile.role !== 'super_admin') {
        return res.status(403).json({ error: 'Alleen super_admin kan rollen beheren.' });
      }
      const target = add_role !== undefined ? add_role : remove_role;
      if (!VALID_ROLES.includes(target)) {
        return res.status(400).json({ error: `Ongeldige rol. Kies uit: ${VALID_ROLES.join(', ')}.` });
      }

      if (add_role !== undefined) {
        const { error } = await supabaseAdmin
          .from('user_roles')
          .upsert({ user_id: userId, role: add_role, assigned_by: admin.user.id }, { onConflict: 'user_id,role' });
        if (error) return res.status(500).json({ error: error.message });
        await logAudit({ action: 'add_role', payload: { target_id: userId, role: add_role, admin_email: admin.profile.email }, triggered_by: admin.profile.email });
      } else {
        if (remove_role === 'super_admin') {
          return res.status(400).json({ error: 'De super_admin-rol kan niet via de UI verwijderd worden.' });
        }
        const { data: cur } = await supabaseAdmin.from('user_roles').select('role').eq('user_id', userId);
        if ((cur || []).length <= 1) {
          return res.status(400).json({ error: 'Een gebruiker moet minstens één rol houden.' });
        }
        const { error } = await supabaseAdmin.from('user_roles').delete().eq('user_id', userId).eq('role', remove_role);
        if (error) return res.status(500).json({ error: error.message });
        await logAudit({ action: 'remove_role', payload: { target_id: userId, role: remove_role, admin_email: admin.profile.email }, triggered_by: admin.profile.email });
      }

      const { data: updated } = await supabaseAdmin.from('user_roles').select('role').eq('user_id', userId);
      const roleNames = (updated || []).map((r) => r.role);
      // Sync profiles.role (primair, voor legacy requireAuth) = hoogste rol. Soft-fail.
      const primary = computeHighestRole(roleNames);
      const { error: syncErr } = await supabaseAdmin.from('profiles').update({ role: primary }).eq('id', userId);
      if (syncErr) console.error('[admin-users] profiles.role sync mislukt (soft):', syncErr.message);
      return res.status(200).json({ message: 'Rollen bijgewerkt.', roles: roleNames, primary_role: primary });
    }

    const updates = {};

    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `Ongeldige rol. Kies uit: ${VALID_ROLES.join(', ')}.` });
      }
      if (role === 'super_admin' && admin.profile.role !== 'super_admin') {
        return res.status(403).json({ error: 'Alleen super_admin kan de super_admin-rol toekennen.' });
      }
      // Defense-in-depth: nu nog fail-open (admin.users.edit niet in registry),
      // wordt strict zodra de feature-key wordt toegekend aan admin-rollen.
      const editAllowed = await requirePermissionFailOpen(req, 'admin.users.edit');
      if (!editAllowed) {
        return res.status(403).json({ error: 'Geen rechten om gebruikers te bewerken.' });
      }
      updates.role = role;
    }
    if (is_active !== undefined) updates.is_active = is_active;
    if (full_name !== undefined) updates.full_name = full_name;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Geen velden om bij te werken.' });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select('email')
      .single();

    if (error) {
      await logAudit({
        action:        'update_user',
        payload:       { target_id: userId, admin_email: admin.profile.email, changes: updates },
        status:        'error',
        error_message: error.message,
        triggered_by:  admin.profile.email,
      });
      return res.status(500).json({ error: error.message });
    }

    // ── Sync user_roles bij primary-role-wijziging (drift-fix) ──────────────
    // Probleem vóór fix: profiles.role veranderde maar user_roles bleef stale,
    // waardoor permissions (UNION over user_roles) verkeerde rol bleven geven.
    // Pattern: UPSERT nieuwe rol eerst, daarna DELETE alle andere rollen — zo
    // houdt user altijd ≥1 rol ook bij gedeeltelijke failure.
    if (role !== undefined) {
      const { error: upErr } = await supabaseAdmin
        .from('user_roles')
        .upsert({ user_id: userId, role, assigned_by: admin.user.id }, { onConflict: 'user_id,role' });
      if (upErr) {
        console.error('[admin-users] user_roles upsert mislukt:', upErr.message);
        await logAudit({
          action:        'update_user_roles_sync',
          payload:       { target_id: userId, role, admin_email: admin.profile.email },
          status:        'error',
          error_message: 'upsert: ' + upErr.message,
          triggered_by:  admin.profile.email,
        });
        return res.status(500).json({ error: 'profiles geüpdatet maar user_roles sync mislukte: ' + upErr.message });
      }
      const { error: delErr } = await supabaseAdmin
        .from('user_roles')
        .delete()
        .eq('user_id', userId)
        .neq('role', role);
      if (delErr) {
        console.error('[admin-users] user_roles cleanup mislukt:', delErr.message);
        await logAudit({
          action:        'update_user_roles_sync',
          payload:       { target_id: userId, role, admin_email: admin.profile.email },
          status:        'error',
          error_message: 'delete-other: ' + delErr.message,
          triggered_by:  admin.profile.email,
        });
        // Niet fataal: nieuwe rol staat erin, oude rollen zijn (deels) er nog.
        // RBAC-UNION zou nog steeds een te ruime permissie kunnen geven — log,
        // maar laat de happy-path response landen zodat admin niet vastloopt.
      }
    }

    // Detecteer reactivate_user vs update_user
    const auditAction = (is_active === true)  ? 'reactivate_user'
                      : (is_active === false) ? 'deactivate_user'
                      :                         'update_user';

    await logAudit({
      action:       auditAction,
      payload: {
        target_email: data?.email,
        target_id:    userId,
        admin_email:  admin.profile.email,
        changes:      updates,
      },
      status:       'success',
      triggered_by: admin.profile.email,
    });

    return res.status(200).json({ message: 'Profiel bijgewerkt.' });
  }

  // ── DELETE — soft delete: deactiveer (nooit jezelf) ───────────────────────

  if (req.method === 'DELETE') {
    const userId = req.query.id;
    if (!userId) return res.status(400).json({ error: 'Query parameter ?id is verplicht.' });

    if (userId === admin.user.id) {
      return res.status(400).json({ error: 'Je kunt je eigen account niet deactiveren.' });
    }

    const updates = { is_active: false, updated_at: new Date().toISOString() };

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select('email')
      .single();

    if (error) {
      await logAudit({
        action:        'deactivate_user',
        payload:       { target_id: userId, admin_email: admin.profile.email },
        status:        'error',
        error_message: error.message,
        triggered_by:  admin.profile.email,
      });
      return res.status(500).json({ error: error.message });
    }

    await logAudit({
      action:       'deactivate_user',
      payload:      { target_email: data?.email, target_id: userId, admin_email: admin.profile.email },
      status:       'success',
      triggered_by: admin.profile.email,
    });

    return res.status(200).json({ message: 'Gebruiker gedeactiveerd.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ error: `Methode ${req.method} niet toegestaan.` });
}
