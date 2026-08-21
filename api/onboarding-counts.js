// api/onboarding-counts.js
// GET → aggregate onboarding-tellingen voor dashboard-badge.
// active = aangemeld + bezig (nog niet afgerond en niet gearchiveerd).
//
// Response:
//   {
//     active_count: N,       // aangemeld + bezig
//     by_status: { aangemeld: N, bezig: N, afgerond: N, gearchiveerd: N },
//     total: N,
//   }
//
// Permission: onboarding.view (fallback: leads.view — onboarding is een
// vervolg op sales-conversie).
// Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ACTIVE_STATUSES = ['aangemeld', 'bezig'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = (await requirePermission(req, 'onboarding.view'))
    || (await requirePermission(req, 'leads.view'));
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  try {
    // Alle statussen in één ronde ophalen — onboardings-tabel blijft klein
    // (typisch <1000 rows). Group-by in JS voor eenvoud.
    // Test-data (is_test=true) uitgesloten — automation-tester zet die vlag
    // op ~zelf-onboarding-rijen en die horen niet in het dashboard-getal.
    const { data, error } = await supabaseAdmin
      .from('onboardings')
      .select('status')
      .eq('is_test', false)
      .limit(20000);
    if (error) throw new Error('onboardings: ' + error.message);

    const by = Object.create(null);
    for (const row of (data || [])) {
      const s = row && row.status ? String(row.status) : 'onbekend';
      by[s] = (by[s] || 0) + 1;
    }
    const active = ACTIVE_STATUSES.reduce((s, k) => s + (by[k] || 0), 0);
    const total  = (data || []).length;

    return res.status(200).json({
      active_count: active,
      by_status:    by,
      total,
    });
  } catch (e) {
    console.error('[onboarding-counts]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
