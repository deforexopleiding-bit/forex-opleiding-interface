// api/meta-lead-settings-get.js
//
// Leest de Meta-koppeling-instellingen + de connectiestatus voor het paneel in
// leadsonderhoud. Permission: leads.view.
//
//   GET → { settings: { funnels, testmode, test_event_code }, geconfigureerd,
//           connectie: { pixel_id, token_actief } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { leesMetaLeadSettings } from './_lib/meta-lead-settings.js';
import { labMetaConfig } from './_lib/lab-meta.js';

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
    const s = await leesMetaLeadSettings(supabaseAdmin);
    const cfg = labMetaConfig();   // pixel-id + of de token gezet is (nooit de token-waarde)
    return res.status(200).json({
      settings: { funnels: s.funnels, testmode: s.testmode, test_event_code: s.test_event_code },
      geconfigureerd: s.geconfigureerd,
      connectie: { pixel_id: cfg.pixelId || null, token_actief: !!cfg.token },
    });
  } catch (e) {
    console.error('[meta-lead-settings-get]', e?.message || e);
    return res.status(500).json({ error: 'Kon instellingen niet laden' });
  }
}
