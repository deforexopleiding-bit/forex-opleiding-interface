// api/agenda-beschikbaarheid-get.js
//
// Leest de agenda-beschikbaarheid uit app_settings['agenda_beschikbaarheid']
// voor het Funnel-dashboard. Eén gezamenlijke opstartsessie-agenda.
//
//   GET → { max_per_dag:int, gesloten_dagen:[ 'YYYY-MM-DD' ], gesloten_ranges:[ {van,tot} ] }
//
// Permission: leads.view (zelfde als het funnel-dashboard).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const KEY = 'agenda_beschikbaarheid';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  try {
    const { data } = await supabaseAdmin.from('app_settings').select('value').eq('key', KEY).maybeSingle();
    const v = (data && data.value && typeof data.value === 'object') ? data.value : {};
    const max = Number.isFinite(Number(v.max_per_dag)) && Number(v.max_per_dag) > 0 ? Math.floor(Number(v.max_per_dag)) : 0;
    const dagen = (Array.isArray(v.gesloten_dagen) ? v.gesloten_dagen : [])
      .filter((d) => typeof d === 'string' && DATE_RE.test(d)).sort();
    const ranges = (Array.isArray(v.gesloten_ranges) ? v.gesloten_ranges : [])
      .filter((r) => r && typeof r.van === 'string' && DATE_RE.test(r.van) && typeof r.tot === 'string' && DATE_RE.test(r.tot))
      .map((r) => ({ van: r.van, tot: r.tot }));
    return res.status(200).json({ max_per_dag: max, gesloten_dagen: [...new Set(dagen)], gesloten_ranges: ranges });
  } catch (e) {
    console.error('[agenda-beschikbaarheid-get]', e?.message || e);
    return res.status(200).json({ max_per_dag: 0, gesloten_dagen: [], gesloten_ranges: [] });
  }
}
