// api/opstartsessie-flow-set.js
//
// Schrijft de boek-flow-schakelaar (A/B/C) naar app_settings.opstartsessie_flow.
// De dfo-website-funnels lezen 'm runtime (binnen ~1 min live). A blijft de
// veilige fallback: alles wat geen 'A'/'B'/'C' is, wordt genegeerd.
//
//   POST { default: 'A'|'B'|'C', per_funnel: { <bron>: 'A'|'B'|'C' } }
//   → 200 { ok:true, default, per_funnel }
//
// Permission: leads.update (wijzigen welke flow live staat = leadbeheer).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const KEY = 'opstartsessie_flow';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const flow = (x) => (x === 'A' || x === 'B' || x === 'C' ? x : null);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const def = flow(body.default) || 'A';
  const per = {};
  if (body.per_funnel && typeof body.per_funnel === 'object' && !Array.isArray(body.per_funnel)) {
    for (const [k, v] of Object.entries(body.per_funnel)) {
      const f = flow(v);
      if (f && typeof k === 'string' && SLUG_RE.test(k)) per[k] = f;
    }
  }
  const value = { default: def, per_funnel: per };

  try {
    const { error } = await supabaseAdmin.from('app_settings').upsert({ key: KEY, value }, { onConflict: 'key' });
    if (error) throw error;
    return res.status(200).json({ ok: true, ...value });
  } catch (e) {
    console.error('[opstartsessie-flow-set]', e?.message || e);
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
}
