// api/leadsonderhoud-berichten-log.js
//
// GET -> berichten_log rijen (alle statussen: verstuurd/droog/fout),
// laatste 14d, met optionele filters op ?traject= en ?status= en ?soort=.
//
// Verschil met leadsonderhoud-droogloop-log:
//   - deze endpoint toont alle statussen (niet alleen 'droog')
//   - 14d ipv 7d (beter voor debugging/audit)
//   - ?limit=<n> instelbaar (default 200, max 500)
//
// Response: { items: [...], totaal, statussen: {verstuurd, droog, fout} }
// Permission: leads.view

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const asArr = (x) => Array.isArray(x) ? x : [];

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

  const traject = typeof req.query?.traject === 'string' ? req.query.traject.trim() : '';
  const status  = typeof req.query?.status  === 'string' ? req.query.status.trim()  : '';
  const soort   = typeof req.query?.soort   === 'string' ? req.query.soort.trim()   : '';
  let limit = Number(req.query?.limit || 200);
  if (!Number.isFinite(limit) || limit < 1) limit = 200;
  if (limit > 500) limit = 500;

  try {
    const veertienDagen = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    let query = supabaseAdmin
      .from('berichten_log')
      .select('id, gebruiker_id, lead_id, traject, soort, kanaal, naar, agent, verstuurd_op, status')
      .gte('verstuurd_op', veertienDagen)
      .order('verstuurd_op', { ascending: false })
      .limit(limit);
    if (traject) query = query.eq('traject', traject);
    if (status)  query = query.eq('status', status);
    if (soort)   query = query.eq('soort', soort);

    const { data, error } = await query;
    if (error) throw error;
    const items = asArr(data);

    const statussen = { verstuurd: 0, droog: 0, fout: 0 };
    for (const r of items) {
      const s = String(r.status || '').toLowerCase();
      if (s in statussen) statussen[s]++;
    }

    return res.status(200).json({ items, totaal: items.length, statussen });
  } catch (e) {
    console.error('leadsonderhoud-berichten-log mislukt:', e.message);
    return res.status(500).json({ error: e.message || 'Interne fout' });
  }
}
