// api/meta-lead-settings-set.js
//
// Slaat de Meta-koppeling-instellingen op in app_settings.meta_lead_settings.
// Permission: leads.update. De sender (crm-lead-meta.js) + lab-aanmelding lezen
// 'm runtime.
//
//   POST { funnels: { opstartsessie, webinar, lab }, testmode, test_event_code }
//   → 200 { ok:true, funnels, testmode, test_event_code }
//
// GEEN consent-schakelaar: de toestemmings-gate blijft hard in de code.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { META_LEAD_SETTINGS_KEY, META_FUNNELS } from './_lib/meta-lead-settings.js';

const bool = (v, def) => (v === true ? true : v === false ? false : def);

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
  const inFunnels = (body.funnels && typeof body.funnels === 'object') ? body.funnels : {};
  const funnels = {};
  for (const k of META_FUNNELS) funnels[k] = bool(inFunnels[k], true);   // default AAN
  const testmode = bool(body.testmode, false);
  // Test-event-code: alleen Meta's eigen tekenset, afgekapt.
  const test_event_code = String(body.test_event_code || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);

  const value = { funnels, testmode, test_event_code };

  try {
    const { error } = await supabaseAdmin.from('app_settings').upsert({ key: META_LEAD_SETTINGS_KEY, value }, { onConflict: 'key' });
    if (error) throw error;
    return res.status(200).json({ ok: true, ...value });
  } catch (e) {
    console.error('[meta-lead-settings-set]', e?.message || e);
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
}
