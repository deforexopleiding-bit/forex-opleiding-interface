// api/incasso-bureaus-delete.js
// POST { id } → soft-delete van een incasso-bureau (is_active=false).
// Guard: weiger als er nog OPEN dossiers aan het bureau hangen
// (dunning_incasso_dossiers met status ∈ ('aangemeld','lopend')).
// Anders: is_active=false, waardoor het bureau uit incasso-bureaus-list
// verdwijnt (die filtert op is_active=true), maar dossier-historie blijft
// intact via bureau_id-koppeling.
//
// Permission: finance.incasso.manage (zelfde als upsert/list).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_DOSSIER_STATUSES = ['aangemeld', 'lopend'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const id = typeof body.id === 'string' && UUID_RE.test(body.id) ? body.id : null;
  if (!id) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    // Bestaanscheck: bureau moet bestaan (en niet al soft-deleted zijn).
    const { data: bureau, error: bErr } = await supabaseAdmin
      .from('dunning_incasso_bureaus')
      .select('id, name, is_active')
      .eq('id', id)
      .maybeSingle();
    if (bErr) throw new Error('bureau lookup: ' + bErr.message);
    if (!bureau) return res.status(404).json({ error: 'Bureau niet gevonden' });
    if (bureau.is_active === false) {
      // Idempotent: al soft-deleted → geen 4xx, retourneer ok:true.
      return res.status(200).json({ ok: true, id, unchanged: true });
    }

    // Guard: open dossiers?
    const { count: openDossierCount, error: dErr } = await supabaseAdmin
      .from('dunning_incasso_dossiers')
      .select('id', { count: 'exact', head: true })
      .eq('bureau_id', id)
      .in('status', OPEN_DOSSIER_STATUSES);
    if (dErr) throw new Error('dossiers count: ' + dErr.message);
    if ((openDossierCount || 0) > 0) {
      return res.status(409).json({
        error: `Kan bureau "${bureau.name}" niet verwijderen: er ${openDossierCount === 1 ? 'is nog 1 open dossier' : 'zijn nog ' + openDossierCount + ' open dossiers'} aan gekoppeld (status ∈ aangemeld/lopend). Sluit of herroute die eerst.`,
        code : 'BUREAU_HAS_OPEN_DOSSIERS',
        open_dossier_count: openDossierCount,
      });
    }

    const { error: uErr } = await supabaseAdmin
      .from('dunning_incasso_bureaus')
      .update({ is_active: false })
      .eq('id', id);
    if (uErr) throw new Error('update: ' + uErr.message);

    return res.status(200).json({ ok: true, id, deleted: true });
  } catch (e) {
    console.error('[incasso-bureaus-delete]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
