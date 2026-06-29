// api/team-member-ensure.js
//
// POST → zorgt dat er een actieve team_members-rij hangt aan een gegeven
// auth.users-id. Idempotent:
//   - bestaat al een rij met user_id = body.user_id → flip is_active=true,
//     return die rij.
//   - anders → INSERT team_members { name, email, role:'Mentor',
//     type:'mentor', user_id, is_active:true }.
//
// Gate: alleen super_admin (admin.profile.role === 'super_admin'). Anders 403.
// Verifieer: profile bestaat én user heeft de 'mentor'-rol (user_roles met
// fallback op profiles.role). Anders 400.
//
// Schrijft audit-log naar agent_audit_log (zelfde patroon als admin-users.js).
// Vangt unique-name-conflict (23505 op idx_team_members_name) → 409.
//
// Response 200: { team_member_id, name, bubble_user_id }
// 400/403/404/409/500 met { error }.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function logAudit({ action, payload = {}, status = 'success', error_message = null, triggered_by = 'system' }) {
  try {
    const { error } = await supabaseAdmin.from('agent_audit_log').insert({
      agent_name:   'admin',
      action,
      payload,
      result:       {},
      status,
      error_message,
      triggered_by,
    });
    if (error) console.error('[team-member-ensure] audit log insert failed:', error.message);
  } catch (e) {
    console.error('[team-member-ensure] audit log exception:', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: `Methode ${req.method} niet toegestaan.` });
  }

  // ── Auth + super_admin-gate (server-autoritatief; UI is enkel cosmetisch) ──
  const admin = await verifyAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  }
  if (admin.profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin kan een mentor-profiel aanmaken.' });
  }

  // ── Body-validatie ───────────────────────────────────────────────────────
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  if (!userId || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'user_id (uuid) is verplicht.' });
  }

  // ── Profile lookup (naam + email voor de team_member-rij) ────────────────
  const { data: profile, error: profErr } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, role')
    .eq('id', userId)
    .maybeSingle();
  if (profErr) {
    console.error('[team-member-ensure] profile fetch:', profErr.message);
    return res.status(500).json({ error: profErr.message });
  }
  if (!profile) {
    return res.status(404).json({ error: 'Gebruiker niet gevonden in profiles.' });
  }

  // ── Mentor-rol-check (user_roles eerst, fallback op profiles.role) ──────
  const { data: roleRows, error: roleErr } = await supabaseAdmin
    .from('user_roles')
    .select('role')
    .eq('user_id', userId);
  if (roleErr) {
    console.error('[team-member-ensure] user_roles fetch:', roleErr.message);
    return res.status(500).json({ error: roleErr.message });
  }
  const hasMentorRole =
    (roleRows || []).some((r) => r && r.role === 'mentor') ||
    (profile.role === 'mentor');
  if (!hasMentorRole) {
    return res.status(400).json({ error: 'Gebruiker heeft geen mentor-rol. Voeg eerst de mentor-rol toe.' });
  }

  // ── Idempotente ensure ──────────────────────────────────────────────────
  // 1) Bestaat al een team_member met deze user_id? → reactiveer + return.
  {
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('team_members')
      .select('id, name, bubble_user_id, is_active')
      .eq('user_id', userId)
      .maybeSingle();
    if (exErr) {
      console.error('[team-member-ensure] team_members lookup:', exErr.message);
      return res.status(500).json({ error: exErr.message });
    }
    if (existing) {
      if (!existing.is_active) {
        const { error: actErr } = await supabaseAdmin
          .from('team_members')
          .update({ is_active: true })
          .eq('id', existing.id);
        if (actErr) {
          await logAudit({
            action:        'mentor_profile_reactivate',
            payload:       { target_user_id: userId, team_member_id: existing.id, admin_email: admin.profile.email },
            status:        'error',
            error_message: actErr.message,
            triggered_by:  admin.profile.email,
          });
          return res.status(500).json({ error: actErr.message });
        }
        await logAudit({
          action:       'mentor_profile_reactivate',
          payload:      { target_user_id: userId, team_member_id: existing.id, admin_email: admin.profile.email },
          triggered_by: admin.profile.email,
        });
      }
      return res.status(200).json({
        team_member_id: existing.id,
        name:           existing.name,
        bubble_user_id: existing.bubble_user_id || null,
      });
    }
  }

  // 2) Geen rij → nieuwe team_member-rij maken.
  const name = String(profile.full_name || '').trim() || String(profile.email || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Profile heeft geen naam of e-mail om de team_member mee aan te maken.' });
  }

  const insertRow = {
    name,
    email:     profile.email || null,
    role:      'Mentor',
    type:      'mentor',
    user_id:   userId,
    is_active: true,
  };

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('team_members')
    .insert(insertRow)
    .select('id, name, bubble_user_id')
    .single();

  if (insErr) {
    // Unique-name-conflict (idx_team_members_name) — meld 'm specifiek terug
    // zodat de admin een uniekere naam kan kiezen (bv. naam aanpassen in profiles).
    if (insErr.code === '23505') {
      await logAudit({
        action:        'mentor_profile_create',
        payload:       { target_user_id: userId, admin_email: admin.profile.email, attempted_name: name },
        status:        'error',
        error_message: 'naam-conflict',
        triggered_by:  admin.profile.email,
      });
      return res.status(409).json({ error: 'Naam al in gebruik — kies een unieke naam (pas profile.full_name aan en probeer opnieuw).' });
    }
    console.error('[team-member-ensure] insert:', insErr.message);
    await logAudit({
      action:        'mentor_profile_create',
      payload:       { target_user_id: userId, admin_email: admin.profile.email },
      status:        'error',
      error_message: insErr.message,
      triggered_by:  admin.profile.email,
    });
    return res.status(500).json({ error: insErr.message });
  }

  await logAudit({
    action:       'mentor_profile_create',
    payload: {
      target_user_id:  userId,
      team_member_id:  inserted.id,
      admin_email:     admin.profile.email,
      name:            inserted.name,
    },
    triggered_by: admin.profile.email,
  });

  return res.status(200).json({
    team_member_id: inserted.id,
    name:           inserted.name,
    bubble_user_id: inserted.bubble_user_id || null,
  });
}
