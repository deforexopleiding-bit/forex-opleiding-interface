// api/admin-quick-replies-upsert.js
// POST  → create nieuwe whatsapp_quick_replies rij.
// PATCH → update bestaande rij (id via ?id=<uuid> of body.id).
// SUPER_ADMIN ONLY. Audit-log entry per mutatie.
//
// Body (POST):
//   { business_account_id, title, body_text, sort_order=0, is_active=true }
// Body (PATCH):
//   { id?, business_account_id?, title?, body_text?, sort_order?, is_active? }
//
// Validatie:
//   business_account_id : required text
//   title               : required, max 100
//   body_text           : required, max 1024
//   sort_order          : integer (default 0)
//   is_active           : boolean (default true bij INSERT)
//
// Response: { item: row }

import { createUserClient, supabaseAdmin } from './supabase.js';

function validateBusinessAccountId(v) {
  if (typeof v !== 'string') return 'business_account_id: string vereist';
  const s = v.trim();
  if (!s) return 'business_account_id: leeg niet toegestaan';
  if (s.length > 64) return 'business_account_id: max 64 chars';
  return null;
}
function validateTitle(v) {
  if (typeof v !== 'string') return 'title: string vereist';
  const s = v.trim();
  if (!s) return 'title: leeg niet toegestaan';
  if (s.length > 100) return 'title: max 100 chars';
  return null;
}
function validateBodyText(v) {
  if (typeof v !== 'string') return 'body_text: string vereist';
  const s = v.trim();
  if (!s) return 'body_text: leeg niet toegestaan';
  if (s.length > 1024) return 'body_text: max 1024 chars';
  return null;
}
function validateSortOrder(v) {
  if (typeof v !== 'number' || !Number.isInteger(v)) return 'sort_order: integer vereist';
  if (v < 0 || v > 100000) return 'sort_order: bereik 0..100000';
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
    if (error) console.error('[admin-quick-replies-upsert] audit insert failed:', error.message);
  } catch (e) {
    console.error('[admin-quick-replies-upsert] audit exception:', e.message);
  }
}

const SELECT_COLS = 'id, business_account_id, title, body_text, sort_order, is_active, created_at, updated_at';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const method = req.method;
  if (method !== 'POST' && method !== 'PATCH') {
    return res.status(405).json({ error: 'POST of PATCH only' });
  }

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

    const body = req.body || {};

    if (method === 'POST') {
      // -- INSERT --
      const errBaid = validateBusinessAccountId(body.business_account_id);
      if (errBaid) return res.status(400).json({ error: errBaid });
      const errTitle = validateTitle(body.title);
      if (errTitle) return res.status(400).json({ error: errTitle });
      const errBody = validateBodyText(body.body_text);
      if (errBody) return res.status(400).json({ error: errBody });

      const sortOrder = body.sort_order === undefined ? 0 : body.sort_order;
      const errSort = validateSortOrder(sortOrder);
      if (errSort) return res.status(400).json({ error: errSort });

      const payload = {
        business_account_id: String(body.business_account_id).trim(),
        title:               String(body.title).trim(),
        body_text:           String(body.body_text).trim(),
        sort_order:          sortOrder,
        is_active:           body.is_active === false ? false : true,
      };

      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('whatsapp_quick_replies')
        .insert(payload)
        .select(SELECT_COLS)
        .single();

      if (insErr) {
        console.error('[admin-quick-replies-upsert] insert error:', insErr.message);
        await logAudit({ action: 'whatsapp_quick_reply.create', payload, status: 'error', error_message: insErr.message, userId: user.id });
        return res.status(500).json({ error: insErr.message });
      }

      await logAudit({
        action: 'whatsapp_quick_reply.create',
        payload: { id: inserted.id, business_account_id: inserted.business_account_id, title: inserted.title, is_active: inserted.is_active },
        userId: user.id,
      });
      return res.status(200).json({ item: inserted });
    }

    // -- PATCH --
    const id = (req.query?.id || body.id || '').toString().trim();
    if (!id) return res.status(400).json({ error: 'id vereist (query ?id=<uuid> of body.id)' });

    const { data: existing, error: getErr } = await supabaseAdmin
      .from('whatsapp_quick_replies')
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle();
    if (getErr) {
      console.error('[admin-quick-replies-upsert] select error:', getErr.message);
      return res.status(500).json({ error: getErr.message });
    }
    if (!existing) return res.status(404).json({ error: 'Quick reply niet gevonden' });

    const updates = {};
    if (body.business_account_id !== undefined) {
      const errBaid = validateBusinessAccountId(body.business_account_id);
      if (errBaid) return res.status(400).json({ error: errBaid });
      updates.business_account_id = String(body.business_account_id).trim();
    }
    if (body.title !== undefined) {
      const errTitle = validateTitle(body.title);
      if (errTitle) return res.status(400).json({ error: errTitle });
      updates.title = String(body.title).trim();
    }
    if (body.body_text !== undefined) {
      const errBody = validateBodyText(body.body_text);
      if (errBody) return res.status(400).json({ error: errBody });
      updates.body_text = String(body.body_text).trim();
    }
    if (body.sort_order !== undefined) {
      const errSort = validateSortOrder(body.sort_order);
      if (errSort) return res.status(400).json({ error: errSort });
      updates.sort_order = body.sort_order;
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
      .from('whatsapp_quick_replies')
      .update(updates)
      .eq('id', id)
      .select(SELECT_COLS)
      .single();

    if (updErr) {
      console.error('[admin-quick-replies-upsert] update error:', updErr.message);
      await logAudit({ action: 'whatsapp_quick_reply.update', payload: { id, updates }, status: 'error', error_message: updErr.message, userId: user.id });
      return res.status(500).json({ error: updErr.message });
    }

    await logAudit({
      action: 'whatsapp_quick_reply.update',
      payload: { id, before: { title: existing.title, is_active: existing.is_active }, after: { title: updated.title, is_active: updated.is_active } },
      userId: user.id,
    });
    return res.status(200).json({ item: updated });
  } catch (e) {
    console.error('[admin-quick-replies-upsert] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
