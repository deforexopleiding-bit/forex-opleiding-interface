// api/incasso-bureaus-upsert.js
// POST { id?, name, email?, country?, address?, notes?, is_active? }
// Insert (geen id) of update (met id). Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const id      = typeof body.id === 'string' && UUID_RE.test(body.id) ? body.id : null;
  const name    = typeof body.name === 'string' ? body.name.trim() : '';
  const email   = typeof body.email === 'string' ? body.email.trim() : null;
  const country = (body.country === 'BE') ? 'BE' : 'NL';
  const address = typeof body.address === 'string' ? body.address.trim() : null;
  const notes   = typeof body.notes === 'string' ? body.notes.trim() : null;
  const isActive = (body.is_active === false) ? false : true;

  if (!name) return res.status(400).json({ error: 'name is verplicht' });

  try {
    if (id) {
      const { data, error } = await supabaseAdmin
        .from('dunning_incasso_bureaus')
        .update({ name, email, country, address, notes, is_active: isActive })
        .eq('id', id)
        .select('id, name, email, country, address, notes, is_active, created_at')
        .single();
      if (error) throw new Error(error.message);
      return res.status(200).json({ ok: true, bureau: data });
    }
    const { data, error } = await supabaseAdmin
      .from('dunning_incasso_bureaus')
      .insert({ name, email, country, address, notes, is_active: isActive })
      .select('id, name, email, country, address, notes, is_active, created_at')
      .single();
    if (error) throw new Error(error.message);
    return res.status(200).json({ ok: true, bureau: data });
  } catch (e) {
    console.error('[incasso-bureaus-upsert]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
