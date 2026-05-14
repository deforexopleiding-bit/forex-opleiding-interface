// Admin user management endpoint
// All operations require a valid admin Bearer token.
// Writes audit entries to agent_audit_log after every mutation.

import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const VALID_ROLES = ['admin', 'sales', 'mentor', 'administratie', 'viewer'];
const SITE_URL    = 'https://forex-opleiding-interface.vercel.app';

// Service-role client — bypasses RLS for admin operations.
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Auth helper ───────────────────────────────────────────────────────────────

/**
 * Verify Bearer token belongs to an active admin.
 * Returns { user, profile } on success, null otherwise.
 */
async function verifyAdmin(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await supabaseAnon.auth.getUser(token);
  if (userError || !userData?.user) return null;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userData.user.id)
    .single();

  if (!profile || profile.role !== 'admin' || !profile.is_active) return null;
  return { user: userData.user, profile };
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

  const admin = await verifyAdmin(req.headers.authorization);
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
    return res.status(200).json({ users });
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

    const { role, is_active, full_name } = req.body || {};
    const updates = {};

    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `Ongeldige rol. Kies uit: ${VALID_ROLES.join(', ')}.` });
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
