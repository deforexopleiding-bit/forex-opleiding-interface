// api/admin-whatsapp-module-upsert.js
// POST → create nieuwe whatsapp_module_config rij.
// PATCH → update bestaande rij (id via ?id=<uuid> of body.id).
// SUPER_ADMIN ONLY. Audit-log entry per mutatie.
//
// Body (POST):
//   { module, phone_number_id, display_label, business_account_id?, is_active=true }
// Body (PATCH):
//   { id?, module?, phone_number_id?, display_label?, business_account_id?, is_active? }
//   (id mag ook in query staan)
//
// Validatie:
//   module              : required, 1-50 chars, lowercase, [a-z0-9_-]
//   phone_number_id     : required, non-empty string (Meta cijferreeks)
//   display_label       : required, 1-100 chars
//   business_account_id : optional, non-empty string max 64 chars (Meta WABA-id)
//   is_active           : boolean (default true bij INSERT, alleen meegestuurd bij PATCH)
//
// INSERT-pad: UNIQUE(module) → bij conflict 409.
// UPDATE-pad: SELECT existing → MERGE → UPDATE updated_at=now() (trigger doet dit ook,
// maar we sturen het mee voor expliciete duidelijkheid).
//
// Response: { item: row }

import { createUserClient, supabaseAdmin } from './supabase.js';

const MODULE_RX = /^[a-z0-9_-]{1,50}$/;

function validateModule(v) {
  if (typeof v !== 'string') return 'module: string vereist';
  const s = v.trim();
  if (!s) return 'module: leeg niet toegestaan';
  if (s.length > 50) return 'module: max 50 chars';
  if (!MODULE_RX.test(s)) return 'module: alleen lowercase a-z, 0-9, _ en -';
  return null;
}
function validatePhoneNumberId(v) {
  if (typeof v !== 'string') return 'phone_number_id: string vereist';
  const s = v.trim();
  if (!s) return 'phone_number_id: leeg niet toegestaan';
  if (s.length > 64) return 'phone_number_id: max 64 chars';
  return null;
}
function validateDisplayLabel(v) {
  if (typeof v !== 'string') return 'display_label: string vereist';
  const s = v.trim();
  if (!s) return 'display_label: leeg niet toegestaan';
  if (s.length > 100) return 'display_label: max 100 chars';
  return null;
}
// business_account_id is OPTIONAL: null/undefined/'' wordt opgeslagen als NULL,
// non-empty string moet 1-64 chars zijn (Meta WABA-id is een cijferreeks).
function validateBusinessAccountId(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return 'business_account_id: string vereist';
  const s = v.trim();
  if (!s) return null; // lege string → NULL
  if (s.length > 64) return 'business_account_id: max 64 chars';
  return null;
}

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
    if (error) console.error('[admin-whatsapp-module-upsert] audit insert failed:', error.message);
  } catch (e) {
    console.error('[admin-whatsapp-module-upsert] audit exception:', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const method = req.method;
  if (method !== 'POST' && method !== 'PATCH') {
    return res.status(405).json({ error: 'POST of PATCH only' });
  }

  // Auth: Bearer → user → profile.role === 'super_admin'.
  try {
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

    const body = req.body || {};

    if (method === 'POST') {
      // INSERT: alle 3 velden verplicht; is_active default true.
      const errModule = validateModule(body.module);
      if (errModule) return res.status(400).json({ error: errModule });
      const errPnid = validatePhoneNumberId(body.phone_number_id);
      if (errPnid) return res.status(400).json({ error: errPnid });
      const errLabel = validateDisplayLabel(body.display_label);
      if (errLabel) return res.status(400).json({ error: errLabel });
      const errBaid = validateBusinessAccountId(body.business_account_id);
      if (errBaid) return res.status(400).json({ error: errBaid });

      const baidTrimmed = (typeof body.business_account_id === 'string')
        ? body.business_account_id.trim()
        : '';
      const payload = {
        module:              String(body.module).trim(),
        phone_number_id:     String(body.phone_number_id).trim(),
        display_label:       String(body.display_label).trim(),
        business_account_id: baidTrimmed ? baidTrimmed : null,
        is_active:           body.is_active === false ? false : true,
        created_by_user_id:  user.id,
      };

      // ON CONFLICT (module) DO NOTHING → check daarna of rij is teruggekomen.
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .upsert(payload, { onConflict: 'module', ignoreDuplicates: true })
        .select('id, module, phone_number_id, business_account_id, display_label, is_active, created_at, updated_at');

      if (insErr) {
        console.error('[admin-whatsapp-module-upsert] insert error:', insErr.message);
        await logAudit({ action: 'whatsapp_module_config.create', payload, status: 'error', error_message: insErr.message, userId: user.id });
        return res.status(500).json({ error: insErr.message });
      }

      // upsert met ignoreDuplicates returnt lege array bij conflict.
      if (!inserted || inserted.length === 0) {
        return res.status(409).json({ error: `Module '${payload.module}' is al gemapt aan een phone_number_id` });
      }

      const row = inserted[0];
      await logAudit({ action: 'whatsapp_module_config.create', payload: { id: row.id, module: row.module, phone_number_id: row.phone_number_id, business_account_id: row.business_account_id, display_label: row.display_label, is_active: row.is_active }, userId: user.id });
      return res.status(200).json({ item: row });
    }

    // PATCH: id verplicht; minimaal 1 mutatie-veld.
    const id = (req.query?.id || body.id || '').toString().trim();
    if (!id) return res.status(400).json({ error: 'id vereist (query ?id=<uuid> of body.id)' });

    // Existing ophalen.
    const { data: existing, error: getErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('id, module, phone_number_id, business_account_id, display_label, is_active')
      .eq('id', id)
      .maybeSingle();
    if (getErr) {
      console.error('[admin-whatsapp-module-upsert] select error:', getErr.message);
      return res.status(500).json({ error: getErr.message });
    }
    if (!existing) return res.status(404).json({ error: 'Module-config niet gevonden' });

    // Merged updates.
    const updates = {};
    if (body.module !== undefined) {
      const errModule = validateModule(body.module);
      if (errModule) return res.status(400).json({ error: errModule });
      updates.module = String(body.module).trim();
    }
    if (body.phone_number_id !== undefined) {
      const errPnid = validatePhoneNumberId(body.phone_number_id);
      if (errPnid) return res.status(400).json({ error: errPnid });
      updates.phone_number_id = String(body.phone_number_id).trim();
    }
    if (body.display_label !== undefined) {
      const errLabel = validateDisplayLabel(body.display_label);
      if (errLabel) return res.status(400).json({ error: errLabel });
      updates.display_label = String(body.display_label).trim();
    }
    if (body.business_account_id !== undefined) {
      const errBaid = validateBusinessAccountId(body.business_account_id);
      if (errBaid) return res.status(400).json({ error: errBaid });
      // null / lege string → NULL in DB; anders trimmed string.
      if (body.business_account_id === null) {
        updates.business_account_id = null;
      } else {
        const s = String(body.business_account_id).trim();
        updates.business_account_id = s ? s : null;
      }
    }
    if (body.is_active !== undefined) {
      if (typeof body.is_active !== 'boolean') {
        return res.status(400).json({ error: 'is_active: boolean vereist' });
      }
      updates.is_active = body.is_active;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Geen velden om te updaten' });
    }
    updates.updated_at = new Date().toISOString();

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .update(updates)
      .eq('id', id)
      .select('id, module, phone_number_id, business_account_id, display_label, is_active, created_at, updated_at')
      .single();

    if (updErr) {
      console.error('[admin-whatsapp-module-upsert] update error:', updErr.message);
      // UNIQUE-violatie op nieuwe module-naam → 409.
      if ((updErr.code === '23505') || /duplicate key/i.test(updErr.message || '')) {
        await logAudit({ action: 'whatsapp_module_config.update', payload: { id, updates }, status: 'error', error_message: updErr.message, userId: user.id });
        return res.status(409).json({ error: `Module '${updates.module}' is al gemapt aan een phone_number_id` });
      }
      await logAudit({ action: 'whatsapp_module_config.update', payload: { id, updates }, status: 'error', error_message: updErr.message, userId: user.id });
      return res.status(500).json({ error: updErr.message });
    }

    await logAudit({ action: 'whatsapp_module_config.update', payload: { id, before: existing, after: updated }, userId: user.id });
    return res.status(200).json({ item: updated });
  } catch (e) {
    console.error('[admin-whatsapp-module-upsert] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
