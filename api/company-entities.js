// api/company-entities.js
// GET    → actieve bedrijfsentiteiten (TL departments) voor wizard-stap 0.
//          Permission: sales.deal.create (Dave). Query ?include=inactive geeft
//          álle rijen (super_admin only, voor Instellingen-CRUD).
// POST   → nieuwe entiteit. Super_admin only.
// PATCH  → update entiteit (?id=UUID). Super_admin only.
// DELETE → deactivate entiteit (?id=UUID). Super_admin only. Nooit hard-delete.
//
// Ronde-31 FIX 2: writes vroeger via direct-supabase → 403 RLS. Nu server-side
// via supabaseAdmin achter een super_admin-gate. RLS blijft strak; alleen deze
// endpoint kan schrijven.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function isSuperAdmin(userId) {
  if (!userId) return false;
  const { data } = await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle();
  return data?.role === 'super_admin';
}

function cleanBody(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const tl_department_id = typeof b.tl_department_id === 'string' ? b.tl_department_id.trim() : '';
  const name             = typeof b.name === 'string'             ? b.name.trim()             : '';
  const label            = typeof b.label === 'string'            ? b.label.trim()            : '';
  const description      = typeof b.description === 'string'      ? b.description.trim()      : '';
  const display_order    = Number.isFinite(Number(b.display_order)) ? Number(b.display_order) : 0;
  return { tl_department_id, name, label, description, display_order };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  try {
    if (req.method === 'GET') {
      if (!(await requirePermission(req, 'sales.deal.create'))) {
        return res.status(403).json({ error: 'Geen rechten (sales.deal.create)' });
      }
      // ?include=inactive → alle rijen (voor Instellingen-CRUD, super_admin only).
      const includeInactive = String(req.query?.include || '') === 'inactive';
      let q = supabaseAdmin.from('company_entities')
        .select('id, tl_department_id, name, label, description, display_order, is_active')
        .order('display_order', { ascending: true });
      if (!includeInactive) q = q.eq('is_active', true);
      else {
        if (!(await isSuperAdmin(user.id))) return res.status(403).json({ error: 'Alleen super_admin (include=inactive)' });
      }
      const { data, error } = await q;
      if (error) throw error;
      return res.status(200).json({ entities: data || [] });
    }

    // Writes → super_admin only.
    if (!(await isSuperAdmin(user.id))) return res.status(403).json({ error: 'Alleen super_admin mag entiteiten wijzigen' });

    if (req.method === 'POST') {
      const f = cleanBody(req.body);
      if (!f.label) return res.status(400).json({ error: 'label is verplicht' });
      if (!f.tl_department_id) return res.status(400).json({ error: 'tl_department_id is verplicht' });
      const { data, error } = await supabaseAdmin.from('company_entities')
        .insert({ ...f, is_active: true })
        .select('id, tl_department_id, name, label, description, display_order, is_active')
        .single();
      if (error) throw error;
      return res.status(200).json({ ok: true, entity: data });
    }

    if (req.method === 'PATCH') {
      const id = String(req.query?.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (UUID) is verplicht' });
      const f = cleanBody(req.body);
      const patch = {};
      if (f.label)            patch.label            = f.label;
      if (f.tl_department_id) patch.tl_department_id = f.tl_department_id;
      if (typeof req.body?.name        === 'string') patch.name        = f.name;
      if (typeof req.body?.description === 'string') patch.description = f.description;
      if (Number.isFinite(Number(req.body?.display_order))) patch.display_order = f.display_order;
      if (typeof req.body?.is_active === 'boolean') patch.is_active = !!req.body.is_active;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Geen velden om te wijzigen' });
      const { data, error } = await supabaseAdmin.from('company_entities')
        .update(patch).eq('id', id)
        .select('id, tl_department_id, name, label, description, display_order, is_active')
        .single();
      if (error) throw error;
      return res.status(200).json({ ok: true, entity: data });
    }

    if (req.method === 'DELETE') {
      // Soft-delete: alleen is_active = false zetten (nooit hard-delete — historie/MRR-scoping).
      const id = String(req.query?.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (UUID) is verplicht' });
      const { data, error } = await supabaseAdmin.from('company_entities')
        .update({ is_active: false }).eq('id', id)
        .select('id, is_active').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, entity: data });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[company-entities]', req.method, e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
