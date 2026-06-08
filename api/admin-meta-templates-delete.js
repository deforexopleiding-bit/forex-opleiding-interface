// api/admin-meta-templates-delete.js
// DELETE → verwijder whatsapp_meta_templates rij via ?id=<uuid>.
// SUPER_ADMIN ONLY. Alleen toegestaan als status = LOCAL (in C1).
// Audit-log entry per delete.
//
// Query: ?id=<uuid> (required)
//
// Response: { success: true, id }

import { createUserClient, supabaseAdmin } from './supabase.js';

async function logAudit({ action, payload, status = 'success', error_message = null, userId }) {
  try {
    const { error } = await supabaseAdmin.from('agent_audit_log').insert({
      agent_name:    'admin',
      action,
      payload,
      result:        {},
      status,
      error_message,
      triggered_by:  userId || 'system',
    });
    if (error) console.error('[admin-meta-templates-delete] audit insert failed:', error.message);
  } catch (e) {
    console.error('[admin-meta-templates-delete] audit exception:', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'DELETE') return res.status(405).json({ error: 'DELETE only' });

  try {
    // Auth: Bearer → user → profile.role === 'super_admin'.
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });
    if (profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin' });
    }

    const id = (req.query?.id || '').toString().trim();
    if (!id) return res.status(400).json({ error: 'id vereist (query ?id=<uuid>)' });

    // Eerst SELECT: status moet LOCAL zijn voor delete in C1.
    const { data: existing, error: getErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('id, business_account_id, name, language, status')
      .eq('id', id)
      .maybeSingle();
    if (getErr) {
      console.error('[admin-meta-templates-delete] select:', getErr.message);
      return res.status(500).json({ error: getErr.message });
    }
    if (!existing) return res.status(404).json({ error: 'Template niet gevonden' });

    if (existing.status !== 'LOCAL') {
      return res.status(409).json({
        error: `Delete alleen toegestaan op LOCAL templates (huidige status: ${existing.status})`,
      });
    }

    const { error: delErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .delete()
      .eq('id', id);

    if (delErr) {
      console.error('[admin-meta-templates-delete] delete:', delErr.message);
      await logAudit({
        action: 'whatsapp_meta_template.delete',
        payload: { id, before: existing },
        status: 'error',
        error_message: delErr.message,
        userId: user.id,
      });
      return res.status(500).json({ error: delErr.message });
    }

    await logAudit({
      action: 'whatsapp_meta_template.delete',
      payload: { id, before: existing },
      userId: user.id,
    });
    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('[admin-meta-templates-delete] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
