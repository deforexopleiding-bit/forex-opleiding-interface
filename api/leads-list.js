// api/leads-list.js
// GET → lijst leads met filters + zoek. Bron: view public.leads_overzicht.
// Permission: leads.view.
//
// Query-params (alle optioneel):
//   soort          herkomst, exacte match ('instagram' | 'facebook' | ...)
//   traject        traject-type, CASE-INSENSITIVE match ('7-daagse' | 'Membership' | ...)
//   kwalificatie   'toegang' | 'geen toegang' | 'geen'  ('geen' → leeg-filter)
//   bron           'website' | 'funnel' | 'meta' | 'handmatig'
//   status         'nieuw' | 'opgevolgd' | 'gewonnen' | 'verloren'
//   afspraak       'ja' (afspraak_op gezet) | 'nee' (leeg) — "Call gepland"-filter
//   q              zoek op naam OR email (ilike)
//   limit          default 50, clamp [1..500]
//   offset         default 0
//
// Response:
//   { items: [...], total, has_more, limit, offset }
//
// Nieuwste bovenaan: order by aangemaakt desc.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const q = req.query || {};
  const soort = q.soort ? String(q.soort).trim() : null;
  // traject-type staat sinds Feature 2 los van soort (= herkomst). CI-filter.
  const traject = q.traject ? String(q.traject).trim() : null;
  const kwal  = q.kwalificatie ? String(q.kwalificatie).trim() : null;
  const bron  = q.bron ? String(q.bron).trim() : null;
  const status = q.status ? String(q.status).trim() : null;
  // Call gepland: 'ja' → afspraak_op gezet, 'nee' → leeg. Anders geen filter.
  const afspraak = q.afspraak ? String(q.afspraak).trim() : null;
  const search = q.q ? String(q.q).trim() : null;
  const limit  = Math.max(1, Math.min(500, Number(q.limit)  || 50));
  const offset = Math.max(0, Number(q.offset) || 0);
  // Soft-delete: standaard alleen actieve leads; ?archief=1 toont het archief.
  const archief = q.archief === '1' || q.archief === 'true';

  // Mag deze gebruiker leads (de)archiveren? Bepaalt of de UI de knoppen toont
  // (de echte afdwinging zit server-side in leads-verwijder/-herstel).
  const canDelete = await requirePermission(req, 'leads.delete');

  try {
    let qy = supabaseAdmin
      .from('leads_overzicht')
      .select('id, naam, email, telefoon, soort, bron, traject, kwalificatie, score, drempel, status, aangemaakt, tag, afspraak_op', { count: 'exact' })
      .order('aangemaakt', { ascending: false })
      .range(offset, offset + limit - 1);

    // Actief vs. archief.
    qy = archief ? qy.not('verwijderd_op', 'is', null) : qy.is('verwijderd_op', null);

    if (soort)   qy = qy.eq('soort', soort);
    // CASE-INSENSITIVE: trajectwaarden zijn gemengd ('Membership'). ilike zonder
    // %/_ = exacte, hoofdletter-ongevoelige match. Escape wildcards uit de input.
    if (traject) qy = qy.ilike('traject', traject.replace(/[%_]/g, m => '\\' + m));
    if (bron)   qy = qy.eq('bron',   bron);
    if (status) qy = qy.eq('status', status);
    if (kwal === 'geen') qy = qy.is('kwalificatie', null);
    else if (kwal)       qy = qy.eq('kwalificatie', kwal);
    if (afspraak === 'ja')      qy = qy.not('afspraak_op', 'is', null);
    else if (afspraak === 'nee') qy = qy.is('afspraak_op', null);
    if (search) {
      const like = `%${search.replace(/[%_]/g, m => '\\' + m)}%`;
      qy = qy.or(`naam.ilike.${like},email.ilike.${like}`);
    }

    const { data, error, count } = await qy;
    if (error) throw new Error('leads_overzicht: ' + error.message);
    const items = data || [];
    return res.status(200).json({
      items,
      total: count || items.length,
      has_more: (offset + items.length) < (count || 0),
      limit, offset,
      can_delete: canDelete,
      archief,
    });
  } catch (e) {
    console.error('[leads-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
