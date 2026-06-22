// api/onboarding-trajecten-list.js
//
// LIST — actieve onboarding-trajecten voor de admin-wizard (dropdown bij
// aanmaak van een nieuwe onboarding). Sorteer op sort_order.
//
// Permission: onboarding.create.
//
// Response 200:
//   { ok:true, trajecten:[{id, key, label, type, duur_maanden, calls}] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'onboarding.create'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.create)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('onboarding_trajecten')
      .select('id, key, label, type, duur_maanden, calls, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .limit(200);
    if (error) throw new Error('trajecten fetch: ' + error.message);

    return res.status(200).json({
      ok        : true,
      trajecten : (data || []).map((t) => ({
        id           : t.id,
        key          : t.key,
        label        : t.label,
        type         : t.type,
        duur_maanden : t.duur_maanden,
        calls        : t.calls,
      })),
    });
  } catch (e) {
    console.error('[onboarding-trajecten-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
