// Admin user management endpoint
// All operations require a valid admin Bearer token.
// Writes audit entries to agent_audit_log after every mutation.

import nodemailer from 'nodemailer';
import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { authRedirectUrlForRole, isCrmStaffRole, CRM_STAFF_ROLES } from './_lib/crm-roles.js';

// BP2 (2026-09-01): 'appointmentsetter' toegevoegd. Blijft synchroon met
// api/_lib/roles.js VALID_SUPABASE_ROLES en met de DB CHECK-constraint
// (migratie 2026-08-31-bp1-appointmentsetter-foundation.sql). Zonder deze
// entry werd elke rol-toekenning aan Romy geblokkeerd met "Ongeldige rol"
// en viel reactivate terug op existing.role — wat de escalatie kon
// verergeren als profiles.role al fout stond.
const VALID_ROLES = ['super_admin', 'admin', 'manager', 'sales', 'mentor', 'marketing', 'administratie', 'appointmentsetter', 'viewer'];
// SITE_URL/LMS-URL + de rollen-whitelist wonen in api/_lib/crm-roles.js,
// zodat CRM-frontend, API en RLS dezelfde definitie van 'CRM-staff' delen.

// Rol-hiërarchie (hoog → laag). Gebruikt om profiles.role (primair, voor legacy
// requireAuth) te syncen met de hoogste rol uit user_roles. Houd identiek aan
// api/admin-rbac-backfill-roles.js.
// BP2 (2026-09-01): 'appointmentsetter' toegevoegd, laag in de priority
// (net boven viewer) — 't is een beperkte operationele rol. Synchroon met
// api/_lib/roles.js ROLE_PRIORITY.
const ROLE_PRIORITY = ['super_admin', 'admin', 'manager', 'sales', 'mentor', 'administratie', 'marketing', 'appointmentsetter', 'viewer'];

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
  // Niet-CRM-rollen (viewer/student) krijgen een link naar het LMS, niet naar
  // het Command Center. De tekst moet dat spiegelen, anders stuurt de mail ze
  // alsnog mentaal naar het CRM.
  const isStaff     = isCrmStaffRole(role);
  const platformNaam = isStaff ? 'Agency Command Center' : 'leeromgeving';

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
            Je bent toegevoegd als gebruiker van de <strong>${platformNaam}</strong> van De Forex Opleiding.
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

  const text = `Welkom bij De Forex Opleiding — ${platformNaam}

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

// role bepaalt WAAR de link op uitkomt. Een student/viewer mag nooit in het
// CRM landen, dus die krijgt het LMS als redirectTo mee. De algemene Supabase
// Site URL blijft ongemoeid — die gebruiken CRM-staff voor login/reset.
async function generateRecoveryLink(email, role) {
  const redirectTo = authRedirectUrlForRole(role);
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type:    'recovery',
    email,
    options: { redirectTo },
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
    // v=... quick-win B: filter op CRM_STAFF_ROLES (super_admin / admin /
    // manager / sales / mentor / administratie / marketing). Voorkomt dat
    // auto-aangemaakte viewer/student-accounts (LMS-signups via
    // handle_new_user trigger) in de team-lijst tonen. Zelfde whitelist als
    // RLS is_crm_staff() + crm-guard.js.
    const { data: users, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .in('role', CRM_STAFF_ROLES)
      .is('deleted_at', null)   // 2026-08-24: soft-deleted verbergen
      .order('role')
      .order('email');

    if (error) return res.status(500).json({ error: error.message });

    // Multi-role: voeg alle user_roles per gebruiker toe (bron van waarheid voor permissions)
    const { data: roleRows } = await supabaseAdmin.from('user_roles').select('user_id, role');
    const rolesByUser = {};
    (roleRows || []).forEach((r) => { (rolesByUser[r.user_id] ||= []).push(r.role); });

    // Team-member-koppeling per user: nodig voor de Bewerken-modal (mentor↔Bubble).
    // Eén query, geen N+1. Onbestaand → team_member_id + bubble_user_id blijven null.
    const userIds = (users || []).map((u) => u.id).filter(Boolean);
    const tmByUser = {};
    if (userIds.length > 0) {
      const { data: tmRows } = await supabaseAdmin
        .from('team_members')
        .select('id, user_id, bubble_user_id')
        .in('user_id', userIds);
      (tmRows || []).forEach((t) => {
        if (t && t.user_id && !tmByUser[t.user_id]) tmByUser[t.user_id] = t;
      });
    }

    const withRoles = (users || []).map((u) => {
      const tm = tmByUser[u.id] || null;
      return {
        ...u,
        all_roles:      rolesByUser[u.id] || (u.role ? [u.role] : []),
        team_member_id: tm ? tm.id : null,
        bubble_user_id: tm ? (tm.bubble_user_id || null) : null,
      };
    });

    return res.status(200).json({ users: withRoles });
  }

  // ── POST — nieuwe user aanmaken ÓÓÓF resend invite ────────────────────────

  if (req.method === 'POST') {
    const { email, full_name, role, resend_only, reactivate } = req.body || {};

    if (!email) return res.status(400).json({ error: 'E-mailadres is verplicht.' });

    // Aanmaken/heractiveren is super_admin-only vanaf v79 (auth-scope).
    // Resend-invite blijft admin/manager toegankelijk.
    if (!resend_only && admin.profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin kan gebruikers aanmaken of heractiveren.' });
    }

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
        const actionLink = await generateRecoveryLink(email, existingProfile.role);
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

    // ── Collisie-guard: actief vs soft-deleted profile ──────────────────────
    // v79-uitbreiding: onderscheid actief (409, weiger) vs soft-deleted
    // (409 met code 'reactivate_available' → UI biedt heractivate aan;
    // caller kan opnieuw POSTen met reactivate=true om het bestaande account
    // te herstellen i.p.v. dubbel aan te maken).
    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, role, is_active, deleted_at')
      .eq('email', email)
      .maybeSingle();

    if (existing && existing.deleted_at === null) {
      return res.status(409).json({ error: 'Er bestaat al een actief account met dit e-mailadres.', code: 'active_duplicate' });
    }

    if (existing && existing.deleted_at !== null && !reactivate) {
      return res.status(409).json({
        error: 'Er bestaat een verwijderde gebruiker met dit e-mailadres. Heractiveer om te herstellen.',
        code:  'reactivate_available',
        deleted_user: {
          id:        existing.id,
          full_name: existing.full_name,
          role:      existing.role,
        },
      });
    }

    // ── Heractivate-pad: bestaande soft-deleted user herstellen ─────────────
    // Herstelt profiles.deleted_at + is_active, cleart auth-ban, en syncet
    // profiles.role + user_roles naar de nieuwe (of behouden) rol. Verstuurt
    // een nieuwe recovery-link zodat de user meteen weer kan inloggen.
    if (existing && existing.deleted_at !== null && reactivate === true) {
      const restoredRole = (role && VALID_ROLES.includes(role)) ? role : existing.role;
      if (restoredRole === 'super_admin' && admin.profile.role !== 'super_admin') {
        return res.status(403).json({ error: 'Alleen super_admin kan de super_admin-rol toekennen.' });
      }
      const restoredName = full_name || existing.full_name || '';

      // 1) profiles: deleted_at=NULL + is_active=true + role/name sync.
      const nowIso = new Date().toISOString();
      const { error: profErr } = await supabaseAdmin
        .from('profiles')
        .update({ deleted_at: null, is_active: true, role: restoredRole, full_name: restoredName, updated_at: nowIso })
        .eq('id', existing.id);
      if (profErr) return res.status(500).json({ error: 'profiles heractivate: ' + profErr.message });

      // 2) auth-unban.
      try {
        const { error: unbanErr } = await supabaseAdmin.auth.admin.updateUserById(existing.id, { ban_duration: 'none' });
        if (unbanErr) console.warn('[admin-users] reactivate auth-unban (soft):', unbanErr.message);
      } catch (e) {
        console.warn('[admin-users] reactivate auth-unban exception (soft):', e?.message || e);
      }

      // 3) user_roles sync — leeg maken, dan single canonieke rol.
      try {
        await supabaseAdmin.from('user_roles').delete().eq('user_id', existing.id);
        await supabaseAdmin.from('user_roles').upsert(
          { user_id: existing.id, role: restoredRole, assigned_by: admin.user.id },
          { onConflict: 'user_id,role' },
        );
      } catch (e) {
        console.warn('[admin-users] reactivate user_roles sync (soft):', e?.message || e);
      }

      // 4) Nieuwe invite-mail zodat gebruiker meteen wachtwoord kan resetten.
      let mailSent = false; let mailError = null;
      try {
        const actionLink = await generateRecoveryLink(email, restoredRole);
        await sendInviteMail({ toEmail: email, fullName: restoredName || email, role: restoredRole, actionLink });
        mailSent = true;
      } catch (e) {
        mailError = e.message;
        console.error('[admin-users] reactivate mail failed:', e.message);
      }

      await logAudit({
        action:  'reactivate_user',
        payload: { target_email: email, target_id: existing.id, admin_email: admin.profile.email, role: restoredRole, mail_sent: mailSent, ...(mailError ? { mail_error: mailError } : {}) },
        status:  'success',
        triggered_by: admin.profile.email,
      });

      return res.status(200).json({
        user: { id: existing.id, email, full_name: restoredName, role: restoredRole, is_active: true },
        mail_sent: mailSent,
        message:   mailSent ? 'Gebruiker heractiveerd; uitnodiging opnieuw verstuurd.' : `Gebruiker heractiveerd maar mail sturen mislukt: ${mailError}`,
      });
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

    // v79-fix: user_roles sync na createUser. De handle_new_user() DB-trigger
    // maakt de profiles-rij aan met de rol uit user_metadata, maar zet géén
    // rij in user_roles. Voeg die hier expliciet toe zodat permission-checks
    // ('any of user_roles') meteen kloppen.
    try {
      await supabaseAdmin.from('user_roles').upsert(
        { user_id: createData.user.id, role, assigned_by: admin.user.id },
        { onConflict: 'user_id,role' },
      );
    } catch (e) {
      console.warn('[admin-users] user_roles insert (soft):', e?.message || e);
    }
    // profiles.role verzekeren (fallback als de trigger role='viewer' zette).
    try {
      await supabaseAdmin.from('profiles').update({ role }).eq('id', createData.user.id);
    } catch (e) {
      console.warn('[admin-users] profiles.role sync (soft):', e?.message || e);
    }

    // Recovery link genereren + branded mail sturen
    let mailSent = false;
    let mailError = null;
    try {
      const actionLink = await generateRecoveryLink(email, role);
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

    const { role, is_active, full_name, add_role, remove_role, email, password, phone, set_canonical_role } = req.body || {};

    // ── Guardrails (super_admin-only destructive actions) ────────────────────
    // (1) Zelf-lockout: super_admin kan zichzelf niet inactief zetten of demoten.
    // (2) Laatste-super_admin: blokkeer is_active=false of role-verlaging als
    //     dat de laatste ACTIEVE super_admin zou wegnemen.
    const isSelfLockoutRisk = (userId === admin.user.id) && (
      is_active === false ||
      (role !== undefined && role !== 'super_admin') ||
      (set_canonical_role !== undefined && set_canonical_role !== 'super_admin')
    );
    if (isSelfLockoutRisk) {
      return res.status(400).json({ error: 'Je kunt jezelf niet inactief zetten of demoten.' });
    }

    // Last-super_admin-check: alleen bij verlaging/deactivering VAN een super_admin.
    const willTouchSuperAdminStatus = (is_active === false) ||
      (role !== undefined && role !== 'super_admin') ||
      (set_canonical_role !== undefined && set_canonical_role !== 'super_admin');
    if (willTouchSuperAdminStatus) {
      const { data: target } = await supabaseAdmin
        .from('profiles').select('role, is_active').eq('id', userId).maybeSingle();
      if (target && target.role === 'super_admin' && target.is_active !== false) {
        const { count: activeSaCount } = await supabaseAdmin
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'super_admin')
          .eq('is_active', true)
          .is('deleted_at', null);
        if ((activeSaCount || 0) <= 1) {
          return res.status(400).json({
            error: 'Kan de laatste actieve super_admin niet inactief zetten of verlagen. Wijs eerst een andere super_admin aan.',
          });
        }
      }
    }

    // [H-10 fix 2026-08-25] Rol-cascade PRE-CHECK — moet vóór auth-ban en vóór
    // set_canonical_role/add_role/remove_role paden, anders zou een manager
    // een admin auth-bannen (10y) en daarna 403 krijgen (halve mutatie).
    // Alleen relevant voor is_active + full_name + role. set_canonical_role
    // en add_role/remove_role zijn al elders super_admin-only.
    if ((is_active !== undefined || full_name !== undefined || role !== undefined) && userId !== admin.user.id) {
      const { data: _tp, error: _tpErr } = await supabaseAdmin
        .from('profiles').select('role').eq('id', userId).maybeSingle();
      if (_tpErr) return res.status(500).json({ error: 'profile pre-check: ' + _tpErr.message });
      if (!_tp)   return res.status(404).json({ error: 'Gebruiker niet gevonden.' });
      const _tRole = _tp.role || 'viewer';
      const _cRole = admin.profile.role;
      if (_cRole !== 'super_admin') {
        const _ci = ROLE_PRIORITY.indexOf(_cRole);
        const _ti = ROLE_PRIORITY.indexOf(_tRole);
        if (_ci < 0 || _ti < 0 || _ci >= _ti) {
          return res.status(403).json({
            error: `Je hebt geen rechten om een gebruiker met rol '${_tRole}' te wijzigen. Rol-cascade vereist strikt hogere caller-rol.`,
          });
        }
      }
    }

    // Auth-ban bij is_active=false / auth-unban bij is_active=true.
    // Blokkeert login echt (Supabase JWT-verify weigert banned users).
    // Fail-soft: als de auth-call faalt (bv. netwerk), log het maar breek de PATCH niet.
    if (is_active !== undefined && (userId !== admin.user.id)) {
      const banValue = is_active === false ? '87600h' : 'none';  // 10 jaar effective ban / uit
      try {
        const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: banValue });
        if (banErr) console.warn('[admin-users] auth-ban update (soft):', banErr.message);
      } catch (e) {
        console.warn('[admin-users] auth-ban exception (soft):', e?.message || e);
      }
    }

    // ── set_canonical_role — single-select rol-switch die profiles.role EN
    // user_roles atomair syncet naar exact één rol. Vervangt de multi-role
    // drift die de UI produceerde toen add_role/remove_role los gebruikt werden.
    if (set_canonical_role !== undefined) {
      if (admin.profile.role !== 'super_admin') {
        return res.status(403).json({ error: 'Alleen super_admin kan de canonieke rol wijzigen.' });
      }
      const newRole = String(set_canonical_role).trim();
      if (!VALID_ROLES.includes(newRole)) {
        return res.status(400).json({ error: `Ongeldige rol. Kies uit: ${VALID_ROLES.join(', ')}.` });
      }
      if (newRole === 'super_admin' && admin.profile.role !== 'super_admin') {
        return res.status(403).json({ error: 'Alleen super_admin kan de super_admin-rol toekennen.' });
      }
      // 1) Verwijder alle andere user_roles-rijen. 2) Insert (of upsert) target.
      // Volgorde bewust: eerst delete-others, dan insert-target — atomicair
      // t.a.v. permission-checks die "any of user_roles" testen.
      const { error: delErr } = await supabaseAdmin.from('user_roles').delete().eq('user_id', userId).neq('role', newRole);
      if (delErr) return res.status(500).json({ error: 'user_roles cleanup: ' + delErr.message });
      const { error: upsertErr } = await supabaseAdmin.from('user_roles')
        .upsert({ user_id: userId, role: newRole, assigned_by: admin.user.id }, { onConflict: 'user_id,role' });
      if (upsertErr) return res.status(500).json({ error: 'user_roles insert: ' + upsertErr.message });
      const { error: profErr } = await supabaseAdmin.from('profiles')
        .update({ role: newRole, updated_at: new Date().toISOString() }).eq('id', userId);
      if (profErr) return res.status(500).json({ error: 'profiles sync: ' + profErr.message });
      await logAudit({
        action: 'set_canonical_role',
        payload: { target_id: userId, role: newRole, admin_email: admin.profile.email },
        triggered_by: admin.profile.email,
      });
      return res.status(200).json({ message: 'Canonieke rol gezet.', role: newRole });
    }

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

    // ── Bewerken-modal (super_admin-only) ───────────────────────────────────
    // Wordt getriggerd zodra de body één van { email, password, phone } bevat.
    // Server-side gate is autoritatief — UI-knop voor niet-super_admin is enkel
    // cosmetisch. In dezelfde call mogen ook full_name + is_active worden gezet.
    const sensitiveIntent = (email !== undefined) || (password !== undefined) || (phone !== undefined);
    if (sensitiveIntent) {
      if (admin.profile.role !== 'super_admin') {
        return res.status(403).json({ error: 'Alleen super_admin kan deze velden bewerken (e-mail/wachtwoord/telefoon).' });
      }

      // changes → profiles-velden (auth-velden gaan via auth.admin separaat).
      // Het rauwe `password` belandt NOOIT in changes of audit-payload.
      const changes = {};
      const auditFields = [];

      // E-mail: valideer formaat + sync via auth.admin (canonieke bron) + profiles.email.
      if (email !== undefined) {
        const normalized = String(email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
          return res.status(400).json({ error: 'Ongeldig e-mailadres.' });
        }
        const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
          email:         normalized,
          email_confirm: true,
        });
        if (authErr) {
          await logAudit({
            action:        'update_user_email',
            payload:       { target_id: userId, admin_email: admin.profile.email },
            status:        'error',
            error_message: authErr.message,
            triggered_by:  admin.profile.email,
          });
          return res.status(400).json({ error: authErr.message });
        }
        changes.email = normalized;
        auditFields.push('email');

        // Sync team_members.email (alleen als er een rij hangt aan deze user).
        // Identity-koppeling blijft op user_id; dit houdt de team-member-email
        // in sync zodat mentor-lijsten dezelfde mail tonen na de wijziging.
        // Fail-soft: een sync-fout breekt de e-mail-wijziging niet.
        try {
          const { error: tmSyncErr } = await supabaseAdmin
            .from('team_members')
            .update({ email: normalized })
            .eq('user_id', userId);
          if (tmSyncErr) {
            console.warn('[admin-users] team_members.email sync (soft):', tmSyncErr.message);
          }
        } catch (e) {
          console.warn('[admin-users] team_members.email sync exception (soft):', e?.message || e);
        }
      }

      // Wachtwoord: min 8 tekens. NOOIT loggen of in response terugzetten.
      if (password !== undefined) {
        const pw = String(password || '');
        if (pw.length < 8) {
          return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens hebben.' });
        }
        const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: pw });
        if (pwErr) {
          await logAudit({
            action:        'update_user_password',
            payload:       { target_id: userId, admin_email: admin.profile.email },
            status:        'error',
            error_message: pwErr.message,
            triggered_by:  admin.profile.email,
          });
          return res.status(400).json({ error: pwErr.message });
        }
        auditFields.push('password');
        // Geen profiles-mutatie voor password — alleen auth.users (gehasht).
      }

      // Telefoon: trim + null-sentinel voor leeg.
      if (phone !== undefined) {
        const trimmed = String(phone || '').trim();
        changes.phone = trimmed === '' ? null : trimmed;
        auditFields.push('phone');
      }

      // Optioneel: full_name + is_active in dezelfde super_admin-call.
      if (full_name !== undefined) { changes.full_name = full_name; auditFields.push('full_name'); }
      if (is_active !== undefined) { changes.is_active = is_active; auditFields.push('is_active'); }

      if (Object.keys(changes).length > 0) {
        changes.updated_at = new Date().toISOString();
        const { error: upErr } = await supabaseAdmin
          .from('profiles')
          .update(changes)
          .eq('id', userId);
        if (upErr) {
          await logAudit({
            action:        'update_user',
            payload:       { target_id: userId, admin_email: admin.profile.email, fields: auditFields },
            status:        'error',
            error_message: upErr.message,
            triggered_by:  admin.profile.email,
          });
          return res.status(500).json({ error: upErr.message });
        }
      }

      // Audit per gewijzigd veld. Wachtwoord krijgt een eigen action zonder waarde.
      for (const field of auditFields) {
        if (field === 'password') {
          await logAudit({
            action:       'update_user_password',
            payload:      { target_id: userId, admin_email: admin.profile.email, field: 'password' },
            triggered_by: admin.profile.email,
          });
        } else {
          const safePayload = { target_id: userId, admin_email: admin.profile.email, field };
          if (field in changes) safePayload.new_value = changes[field];
          await logAudit({
            action:       'update_user_' + field,
            payload:      safePayload,
            triggered_by: admin.profile.email,
          });
        }
      }

      return res.status(200).json({ message: 'Gebruiker bijgewerkt.', fields: auditFields });
    }

    // ── [K-02 fix 2026-08-25] Rol-cascade fetch — target-rol nodig voor H-10
    //     (is_active=false cascade), M-04 (full_name cascade) en legacy role-
    //     path blokkade. Fail-closed als target niet bestaat.
    let _targetProfile = null;
    if (is_active !== undefined || full_name !== undefined || role !== undefined) {
      const { data: tp, error: tpErr } = await supabaseAdmin
        .from('profiles').select('id, role, is_active, full_name').eq('id', userId).maybeSingle();
      if (tpErr) return res.status(500).json({ error: 'profile lookup: ' + tpErr.message });
      if (!tp)   return res.status(404).json({ error: 'Gebruiker niet gevonden.' });
      _targetProfile = tp;
    }
    // Cascade-helper: caller mag alleen users met rol ≤ die van jezelf raken.
    // Super_admin bypass. index-vergelijking in ROLE_PRIORITY: lager idx = hoger.
    function _canCascadeOver(callerRole, targetRole) {
      if (callerRole === 'super_admin') return true;
      const ci = ROLE_PRIORITY.indexOf(callerRole);
      const ti = ROLE_PRIORITY.indexOf(targetRole);
      if (ci < 0 || ti < 0) return false;
      return ci < ti; // caller strikt hoger dan target (geen peer-cascade)
    }

    const updates = {};

    if (role !== undefined) {
      // [K-02 fix] Legacy directe role-PATCH is nu super_admin-only. Anti-
      // escalation via set_canonical_role blijft de canonieke route (regel 526).
      // Voorheen kon een manager `updates.role = 'admin'` zetten omdat de gate
      // alleen 'super_admin' blokkeerde → account-takeover via promotie van
      // collega. Vanaf nu:
      //  * niet-super_admin → 403 met verwijzing naar set_canonical_role
      //  * super_admin → mag alle rollen (incl. super_admin) toekennen
      if (admin.profile.role !== 'super_admin') {
        return res.status(403).json({
          error: 'Alleen super_admin kan de canonieke rol via dit pad wijzigen. Gebruik `set_canonical_role`.',
        });
      }
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `Ongeldige rol. Kies uit: ${VALID_ROLES.join(', ')}.` });
      }
      updates.role = role;
    }
    if (is_active !== undefined) {
      // [H-10 fix] Deactivate/reactivate mag alleen op strikt lagere rollen.
      // Zelf-lockout + laatste-super_admin-guards (regel 479-508) blijven ook.
      if (userId !== admin.user.id && _targetProfile && !_canCascadeOver(admin.profile.role, _targetProfile.role || 'viewer')) {
        return res.status(403).json({
          error: `Je hebt geen rechten om een gebruiker met rol '${_targetProfile.role}' te (de)activeren.`,
        });
      }
      updates.is_active = is_active;
    }
    if (full_name !== undefined) {
      // [M-04 fix] Same cascade als [H-10] — voorkomt spoofing van display-
      // namen (audit-trail-vervuiling). Zelf mag altijd.
      if (userId !== admin.user.id && _targetProfile && !_canCascadeOver(admin.profile.role, _targetProfile.role || 'viewer')) {
        return res.status(403).json({
          error: `Je hebt geen rechten om de naam van een gebruiker met rol '${_targetProfile.role}' te wijzigen.`,
        });
      }
      updates.full_name = full_name;
    }

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

  // ── DELETE — SOFT delete (deleted_at) + auth-ban + user_roles-clear ───────
  // 2026-08-24: eerder was DELETE = alleen is_active=false ("deactiveer").
  // Nu echte soft-delete:
  //   1. profiles.deleted_at = now() + is_active=false → uit lijst, gate blijft.
  //   2. auth.users ban_duration = 87600h (10j) → login blokkeert echt.
  //   3. user_roles-rijen verwijderen → geen rol-toegang meer (permissions).
  //   4. profiles-rij BLIJFT bestaan (audit + FK-safety naar leads/messages).
  // Rails: zelf-lockout (bestaand) + last-super_admin-check (nieuw).

  if (req.method === 'DELETE') {
    const userId = req.query.id;
    if (!userId) return res.status(400).json({ error: 'Query parameter ?id is verplicht.' });

    if (userId === admin.user.id) {
      return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen.' });
    }

    if (admin.profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin kan gebruikers verwijderen.' });
    }

    // Last-super_admin-check.
    const { data: target } = await supabaseAdmin
      .from('profiles').select('role, is_active, email').eq('id', userId).maybeSingle();
    if (!target) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });
    if (target.role === 'super_admin' && target.is_active !== false) {
      const { count: activeSaCount } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'super_admin')
        .eq('is_active', true)
        .is('deleted_at', null);
      if ((activeSaCount || 0) <= 1) {
        return res.status(400).json({
          error: 'Kan de laatste actieve super_admin niet verwijderen. Wijs eerst een andere super_admin aan.',
        });
      }
    }

    const nowIso = new Date().toISOString();
    const updates = { deleted_at: nowIso, is_active: false, updated_at: nowIso };

    // 1. Auth-ban zodat de account niet meer kan inloggen. Fail-soft.
    try {
      const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: '87600h' });
      if (banErr) console.warn('[admin-users] soft-delete auth-ban (soft):', banErr.message);
    } catch (e) {
      console.warn('[admin-users] soft-delete auth-ban exception (soft):', e?.message || e);
    }

    // 2. user_roles-rijen verwijderen (rol-permissions neutraliseren).
    try {
      const { error: urErr } = await supabaseAdmin.from('user_roles').delete().eq('user_id', userId);
      if (urErr) console.warn('[admin-users] user_roles cleanup (soft):', urErr.message);
    } catch (e) {
      console.warn('[admin-users] user_roles cleanup exception (soft):', e?.message || e);
    }

    // 3. profiles: deleted_at + is_active=false.
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select('email')
      .single();

    if (error) {
      await logAudit({
        action:        'soft_delete_user',
        payload:       { target_id: userId, admin_email: admin.profile.email },
        status:        'error',
        error_message: error.message,
        triggered_by:  admin.profile.email,
      });
      return res.status(500).json({ error: error.message });
    }

    await logAudit({
      action:       'soft_delete_user',
      payload:      { target_email: data?.email, target_id: userId, admin_email: admin.profile.email, deleted_at: nowIso },
      status:       'success',
      triggered_by: admin.profile.email,
    });

    return res.status(200).json({ message: 'Gebruiker verwijderd (soft-delete). Herstellen kan via DB — data blijft bewaard.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ error: `Methode ${req.method} niet toegestaan.` });
}
