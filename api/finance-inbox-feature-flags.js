// api/finance-inbox-feature-flags.js
// GET → returnt de finance-inbox feature-flags (fase 4 blok 3).
//
// Response 200: { unified_inbox_enabled: boolean }
//
// Bron: joost_config.feature_flags op module='finance'. Als de flag ontbreekt
// of joost_config-rij niet bestaat → false (safe default).
//
// Permission: finance.inbox.view (lezen genoeg — geen mutaties).

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
  if (!(await requirePermission(req, 'finance.inbox.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.view)' });
  }

  try {
    const { data: cfg } = await supabaseAdmin
      .from('joost_config')
      .select('feature_flags')
      .eq('module', 'finance')
      .maybeSingle();
    const flags = (cfg?.feature_flags && typeof cfg.feature_flags === 'object') ? cfg.feature_flags : {};
    // Enige flag die we in fase 4 blok 3 gebruiken. Default false = huidig gedrag.
    return res.status(200).json({
      unified_inbox_enabled: flags.unified_inbox_enabled === true,
    });
  } catch (e) {
    console.error('[finance-inbox-feature-flags]', e?.message || e);
    // Fail-safe: bij DB-fout → default false zodat de inbox exact als nu blijft
    // werken (geen unified rendering triggert).
    return res.status(200).json({ unified_inbox_enabled: false });
  }
}
