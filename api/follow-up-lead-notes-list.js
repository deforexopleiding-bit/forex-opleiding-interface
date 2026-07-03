// api/follow-up-lead-notes-list.js
// GET ?lead_id=<uuid> → follow_up_lead_notes tijdlijn (nieuwste eerst).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const leadId = typeof req.query?.lead_id === 'string' ? req.query.lead_id.trim() : '';
  if (!leadId || !UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id (uuid) vereist' });

  try {
    const { data: notes, error } = await supabaseAdmin
      .from('follow_up_lead_notes')
      .select('id, lead_id, note, created_by_user_id, created_at')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_lead_notes ontbreekt', code: 'MIGRATION_REQUIRED' });
      throw new Error(error.message);
    }

    // Naam van auteurs bij zoeken (profiles.full_name).
    const authorIds = [...new Set((notes || []).map((n) => n.created_by_user_id).filter(Boolean))];
    const nameById = {};
    if (authorIds.length) {
      const { data: profs } = await supabaseAdmin
        .from('profiles').select('id, full_name').in('id', authorIds);
      for (const p of (profs || [])) nameById[p.id] = p.full_name;
    }

    return res.status(200).json({
      notes: (notes || []).map((n) => ({ ...n, author_name: nameById[n.created_by_user_id] || null })),
    });
  } catch (e) {
    console.error('[follow-up-lead-notes-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
