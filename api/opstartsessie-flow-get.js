// api/opstartsessie-flow-get.js
//
// Leest de boek-flow-schakelaar (A/B/C) uit app_settings.opstartsessie_flow en
// geeft 'm terug voor het Funnels-dashboard. A is de veilige fallback.
//
//   GET → { default: 'A'|'B'|'C', per_funnel: { <bron>: 'A'|'B'|'C' } }
//
// Permission: leads.view (zelfde als het funnel-dashboard).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const KEY = 'opstartsessie_flow';

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
    const def = (v.default === 'B' || v.default === 'C') ? v.default : 'A';
    const per = {};
    if (v.per_funnel && typeof v.per_funnel === 'object' && !Array.isArray(v.per_funnel)) {
      for (const [k, val] of Object.entries(v.per_funnel)) if (val === 'A' || val === 'B' || val === 'C') per[k] = val;
    }
    return res.status(200).json({ default: def, per_funnel: per });
  } catch (e) {
    console.error('[opstartsessie-flow-get]', e?.message || e);
    return res.status(200).json({ default: 'A', per_funnel: {} });
  }
}
