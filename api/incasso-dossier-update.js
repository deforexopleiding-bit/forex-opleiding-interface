// api/incasso-dossier-update.js
// POST { id, status?, bureau_id?, notes? } → dossier bijwerken.
// Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = ['aangemeld', 'lopend', 'betaald', 'afgeschreven', 'oninbaar', 'geretourneerd'];

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
  const id       = typeof body.id === 'string' && UUID_RE.test(body.id) ? body.id : null;
  const status   = (typeof body.status === 'string' && VALID_STATUSES.includes(body.status)) ? body.status : null;
  const bureauId = (body.bureau_id === null) ? null
                  : (typeof body.bureau_id === 'string' && UUID_RE.test(body.bureau_id) ? body.bureau_id : undefined);
  const notes    = (body.notes === null) ? null
                  : (typeof body.notes === 'string' ? body.notes : undefined);

  if (!id) return res.status(400).json({ error: 'id (uuid) verplicht' });

  const patch = { updated_at: new Date().toISOString() };
  if (status !== null)      patch.status = status;
  if (bureauId !== undefined) patch.bureau_id = bureauId;
  if (notes !== undefined)   patch.notes    = notes;
  if (Object.keys(patch).length === 1) {
    return res.status(400).json({ error: 'Niets om bij te werken (geef status, bureau_id of notes mee)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('dunning_incasso_dossiers')
      .update(patch)
      .eq('id', id)
      .select('id, customer_id, bureau_id, country, status, notes, updated_at')
      .single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Dossier niet gevonden' });
    return res.status(200).json({ ok: true, dossier: data });
  } catch (e) {
    console.error('[incasso-dossier-update]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
