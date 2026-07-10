// api/finance-dunning-templates-list.js
// GET → lijst dunning_templates. Optional filters: ?kind=email|whatsapp, ?active=true|false.
// Permission: finance.dunning.view (lezen mag ruimer dan beheren).
//
// Response: { items: [{ id, name, kind, subject, body, meta_template_name, language,
//                       is_active, created_at, updated_at }] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const VALID_KINDS = ['email', 'whatsapp', 'brief'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const q = req.query || {};
  const kindFilter = VALID_KINDS.includes(q.kind) ? q.kind : null;
  let activeFilter = null;
  if (q.active === 'true')  activeFilter = true;
  if (q.active === 'false') activeFilter = false;

  try {
    let query = supabaseAdmin
      .from('dunning_templates')
      .select('id, name, kind, subject, body, meta_template_name, language, is_active, created_at, updated_at')
      .order('updated_at', { ascending: false });
    if (kindFilter) query = query.eq('kind', kindFilter);
    if (activeFilter !== null) query = query.eq('is_active', activeFilter);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return res.status(200).json({ items: data || [] });
  } catch (e) {
    console.error('[finance-dunning-templates-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
