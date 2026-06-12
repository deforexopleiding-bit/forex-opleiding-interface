// api/admin-webflow-publish-now.js
// POST -> handmatige "Publish nu" + catch-up bij toggle-flip.
// Admin only (super_admin/admin/manager via verifyAdmin).
//
// Use-cases:
//   1. Admin "Publish nu" knop in /modules/admin.html (integraties-tab).
//   2. Optioneel toekomstig: cron of automation die catch-up triggert bij
//      pending=true langer dan X minuten.
//
// Bypassed toggle + debounce (force=true in forcePublishSite). Lock blijft
// gerespecteerd: als er nu net een publish loopt, returnen we skipped met
// reason='in_progress' zodat caller weet dat er sowieso al een publish is.
//
// Response 200: { ok, published, skipped?, reason?, error?, code? }
// Response 401: niet geauthenticeerd
// Response 403: geen admin
// Response 405: POST only

import { createUserClient, verifyAdmin } from './supabase.js';
import { forcePublishSite } from './_lib/webflow-publish.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });

  const context = (req.body && typeof req.body === 'object' && typeof req.body.context === 'string')
    ? req.body.context.slice(0, 80)
    : 'manual';

  try {
    const result = await forcePublishSite(context);
    return res.status(200).json(result);
  } catch (e) {
    console.error('[admin-webflow-publish-now]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
