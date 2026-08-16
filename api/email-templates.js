// api/email-templates.js
//
// v2 email-round DEEL 2 — Templates CRUD voor compose/reply-picker + admin.
//
// GET                         → alle active templates (name ASC)
// GET  ?id=<uuid>             → 1 template
// POST { name, subject, body_html, body_text, category, variables, is_active }
//                             → upsert; alleen super_admin/admin/manager
// DELETE { id }               → deactivate (is_active=false, soft-delete)
//
// RLS: SELECT open voor authenticated; writes via service-role + role-gate.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function assertTable() {
  try {
    const probe = await supabaseAdmin.from('email_templates').select('id').limit(1);
    if (probe.error && /relation.*email_templates.*does not exist/i.test(probe.error.message || '')) {
      return { ok: false, error: 'Migratie 2026-08-16-email-templates-and-signatures.sql moet eerst gedraaid worden (tabel email_templates ontbreekt).' };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message || 'db check fail' }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const t = await assertTable();
  if (!t.ok) return res.status(503).json({ error: t.error, migration_required: '2026-08-16-email-templates-and-signatures.sql' });

  try {
    if (req.method === 'GET') {
      if (!(await requirePermission(req, 'email.module.access'))) {
        return res.status(403).json({ error: 'Geen rechten (email.module.access)' });
      }
      const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
      if (id) {
        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id niet uuid' });
        const { data, error } = await supabaseAdmin
          .from('email_templates').select('*').eq('id', id).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Template niet gevonden' });
        return res.status(200).json({ item: data });
      }
      // Default: alleen active templates voor de picker. Admin-UI kan
      // ?include_inactive=1 sturen voor beheer.
      const includeInactive = String(req.query?.include_inactive || '') === '1';
      let q = supabaseAdmin.from('email_templates').select('*').order('name', { ascending: true });
      if (!includeInactive) q = q.eq('is_active', true);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ items: data || [] });
    }

    if (req.method === 'POST') {
      // Alleen super_admin/admin/manager mogen templates beheren.
      if (!(await requirePermission(req, 'admin.email_templates'))) {
        // Fallback voor rollen zonder deze specifieke permission: check op super_admin via profiel.
        const { data: prof } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).maybeSingle();
        if (!prof || !['super_admin', 'admin', 'manager'].includes(prof.role)) {
          return res.status(403).json({ error: 'Alleen super_admin/admin/manager mag templates beheren' });
        }
      }
      const b = req.body || {};
      const name = (b.name ? String(b.name).trim() : '').slice(0, 200);
      if (!name) return res.status(400).json({ error: 'name is verplicht' });
      const payload = {
        name,
        subject:   b.subject   ? String(b.subject).slice(0, 500)   : null,
        body_html: b.body_html ? String(b.body_html).slice(0, 500000) : '',
        body_text: b.body_text ? String(b.body_text).slice(0, 500000) : '',
        category:  (b.category ? String(b.category).slice(0, 60) : 'algemeen'),
        variables: Array.isArray(b.variables) ? b.variables.slice(0, 50) : [],
        is_active: b.is_active === false ? false : true,
        updated_at: new Date().toISOString(),
      };
      const id = b.id ? String(b.id).trim() : '';
      let result;
      if (id) {
        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id niet uuid' });
        result = await supabaseAdmin.from('email_templates').update(payload).eq('id', id).select('*').maybeSingle();
      } else {
        payload.created_by_user_id = user.id;
        result = await supabaseAdmin.from('email_templates').insert(payload).select('*').maybeSingle();
      }
      if (result.error) return res.status(500).json({ error: result.error.message });
      return res.status(200).json({ item: result.data });
    }

    if (req.method === 'DELETE') {
      const { data: prof } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (!prof || !['super_admin', 'admin', 'manager'].includes(prof.role)) {
        return res.status(403).json({ error: 'Alleen super_admin/admin/manager mag templates verwijderen' });
      }
      const id = req.query?.id || req.body?.id;
      if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: 'id niet uuid' });
      // Soft-delete: zet is_active=false zodat de picker 'em uitfiltert maar
      // history in verzonden mails niet kapot gaat (als we ooit template_id
      // op email_messages willen tracken).
      const { error } = await supabaseAdmin
        .from('email_templates').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', String(id));
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[email-templates] fail:', e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
