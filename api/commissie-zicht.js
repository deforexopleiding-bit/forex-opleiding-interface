// api/commissie-zicht.js
//
// GET ?deal_id=<uuid>              → { zicht } (kaart op de offertepagina, incl. facturen,
//                                     abonnementen + "vorige offerte had commissie")
// GET ?deal_ids=<uuid>,…[&facturen=1] → { per_deal } (lijsten; max 400)
//
// Alleen lezen. Kern: api/_lib/commissie-zicht.js (grootboek + factuurmotor-
// koppeling + incassostatus; geen eigen rekenwerk).
// Recht: sales.deal.view of mentor.admin.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { laadZicht, zichtVoorDeal } from './_lib/commissie-zicht.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.view')) && !(await requirePermission(req, 'mentor.admin.view'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.view)' });
  }
  try {
    const q = req.query || {};
    if (q.deal_ids) {
      const ids = String(q.deal_ids).split(',').map((s) => s.trim()).filter((s) => UUID_RE.test(s)).slice(0, 400);
      const m = await laadZicht(supabaseAdmin, ids, { metFacturen: String(q.facturen || '') === '1' });
      return res.status(200).json({ ok: true, per_deal: Object.fromEntries(m) });
    }
    const dealId = String(q.deal_id || '').trim();
    if (!UUID_RE.test(dealId)) return res.status(400).json({ error: 'deal_id (uuid) vereist' });
    const zicht = await zichtVoorDeal(supabaseAdmin, dealId);
    if (!zicht) return res.status(404).json({ error: 'Offerte niet gevonden' });
    return res.status(200).json({ ok: true, zicht });
  } catch (e) {
    console.error('[commissie-zicht]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
