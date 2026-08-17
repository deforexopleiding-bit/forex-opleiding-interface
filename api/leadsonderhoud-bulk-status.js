// api/leadsonderhoud-bulk-status.js
//
// GET → lichte status-check voor de bulk-tab. Returnt live-mode-status
// (LEADSONDERHOUD_LIVE + LEADSONDERHOUD_UIT env) zonder DB-write. Voedt
// de droogloop-banner ONAFHANKELIJK van preview — als preview faalt is
// de operator anders blind voor of de cron uit staat.
//
// Gate: leads.view.
//
// Response 200: { live: bool, uit: bool, checked_at: iso }
//
// SEMANTIEK (v=13 documentatie):
//   - `uit`  = LEADSONDERHOUD_UIT env kill-switch is aangezet. Onafhankelijk
//              van `live`. Overheerst ALTIJD: bij uit=true zal de cron NIETS
//              verzenden ongeacht LEADSONDERHOUD_LIVE. UI toont rode kill-
//              switch banner en approve is geblokkeerd.
//   - `live` = LEADSONDERHOUD_LIVE='1' EN uit=false. Zonder deze combi zit
//              de cron in droogloop (fetch + skip claim). Bij live=true én
//              uit=false zal de cron ECHT versturen.
//
// UI-mapping (leadsonderhoud-v2.js _lsBulkRenderBanner):
//   uit=true             → rood "KILL-SWITCH AAN"    (highest priority)
//   uit=false, live=true → rood "LIVE-MODUS AAN — jobs worden ECHT verzonden"
//   uit=false, live=false → groen "UIT — cron verstuurt niets"
//
// Veiligheid: bij onbekend (crash / netwerkfout aan client-kant) MOET de
// UI de status als NIET-veilig behandelen (approve geblokkeerd).

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { liveModeStatus } from './_lib/leadsonderhoud-bulk-template.js';

export default async function handler(req, res) {
  try {
    return await _handleImpl(req, res);
  } catch (e) {
    console.error('[ls-bulk-status] TOP-LEVEL CRASH:', e && e.stack || e?.message || e);
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: 'Status niet leesbaar.', detail: e?.message || String(e) });
    }
  }
}

async function _handleImpl(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  return res.status(200).json(liveModeStatus());
}
