// api/meta-ads-sync-run-now.js
//
// Handmatige trigger voor de Meta Ads-sync vanuit de UI (Meta Ads-tab, knop
// "Ads-data nu ophalen"). Zelfde effect als de */30-cron
// (api/cron-meta-ads-sync.js), maar geauthenticeerd via Bearer JWT + RBAC
// permission-check i.p.v. CRON_SECRET (die mag nooit naar de client).
//
// Permission: ads.module.access (dezelfde die meta-ads-insights.js én
//             meta-ads-roas.js gebruiken).
// Methode: POST only.
//
// Delegeert naar runAdsSync() uit cron-meta-ads-sync.js — die functie doet
// exact hetzelfde als de cron-run (env-gate + per-level sync + touchSyncState).
// Return-shape wordt 1-op-1 doorgegeven zodat de UI dezelfde summary krijgt
// als de cron in sync_state opslaat.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { runAdsSync } from './cron-meta-ads-sync.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1) Auth: geldige Bearer-JWT vereist.
  const supabase = createUserClient(req);
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 2) RBAC.
  const allowed = await requirePermission(req, 'ads.module.access');
  if (!allowed) {
    return res.status(403).json({
      error: 'Insufficient permissions',
      feature: 'ads.module.access',
    });
  }

  // 3) Run sync.
  try {
    const result = await runAdsSync();
    console.log('[meta-ads-sync-run-now]', user.id, JSON.stringify({
      skipped: result.skipped || null,
      errors: result.summary?.errors?.length || 0,
      duration_ms: result.summary?.duration_ms || 0,
    }));
    return res.status(200).json(result);
  } catch (e) {
    console.error('[meta-ads-sync-run-now] fatal', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
